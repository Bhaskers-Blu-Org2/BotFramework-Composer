// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as path from 'path';

import { ResourceManagementClient } from '@azure/arm-resources';
import { ApplicationInsightsManagementClient } from '@azure/arm-appinsights';
import { AzureBotService } from '@azure/arm-botservice';
import {
  Deployment,
  DeploymentsCreateOrUpdateResponse,
  DeploymentsValidateResponse,
  ResourceGroup,
  ResourceGroupsCreateOrUpdateResponse,
} from '@azure/arm-resources/esm/models';
import { GraphRbacManagementClient } from '@azure/graph';
import { DeviceTokenCredentials } from '@azure/ms-rest-nodeauth';
import * as fs from 'fs-extra';
import * as rp from 'request-promise';
import { RuntimeTemplate } from '@bfc/plugin-loader';

import { BotProjectDeployConfig } from './botProjectDeployConfig';
import { BotProjectDeployLoggerType } from './botProjectLoggerType';
import archiver = require('archiver');

const { promisify } = require('util');

const luBuild = require('@microsoft/bf-lu/lib/parser/lubuild/builder.js');
const readdir = promisify(fs.readdir);

export class BotProjectDeploy {
  private subId: string;
  private accessToken: string;
  private creds: any; // credential from interactive login
  private projPath: string;
  private zipPath: string;
  private settingsPath: string;
  private templatePath: string;
  private logger: (string) => any;
  private runtime: RuntimeTemplate;

  // Will be assigned by create or deploy
  private tenantId = '';

  constructor(config: BotProjectDeployConfig) {
    this.subId = config.subId;
    this.logger = config.logger;
    this.accessToken = config.accessToken;
    this.creds = config.creds;
    this.projPath = config.projPath;
    // get the appropriate runtime
    this.runtime = config.runtime;

    // path to the zipped assets
    this.zipPath = config.zipPath ?? path.join(this.projPath, 'code.zip');

    // path to the source appsettings.deployment.json file
    this.settingsPath = config.settingsPath ?? path.join(this.projPath, 'appsettings.deployment.json');

    // path to the ARM template
    // this is currently expected to live in the code project
    this.templatePath =
      config.templatePath ?? path.join(this.projPath, 'DeploymentTemplates', 'template-with-preexisting-rg.json');
  }

  /*******************************************************************************************************************************/
  /* This section has to do with deploying to existing Azure resources 
  /*******************************************************************************************************************************/

  /**
   * return an array of all the files in a given directory
   * @param dir
   */
  private async getFiles(dir: string): Promise<string[]> {
    const dirents = await readdir(dir, { withFileTypes: true });
    const files = await Promise.all(
      dirents.map((dirent) => {
        const res = path.resolve(dir, dirent.name);
        return dirent.isDirectory() ? this.getFiles(res) : res;
      })
    );
    return Array.prototype.concat(...files);
  }

  private async zipDirectory(source: string, out: string) {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const stream = fs.createWriteStream(out);

    return new Promise((resolve, reject) => {
      archive
        .glob('**/*', {
          cwd: source,
          dot: true,
          ignore: ['code.zip'],
        })
        .on('error', (err) => reject(err))
        .pipe(stream);

      stream.on('close', () => resolve());
      archive.finalize();
    });
  }

  private notEmptyLuisModel(file: string) {
    return fs.readFileSync(file).length > 0;
  }

  /**
   * Helper function to get the appropriate account out of a list of accounts
   * @param accounts
   * @param filter
   */
  private getAccount(accounts: any, filter: string) {
    for (const account of accounts) {
      if (account.AccountName === filter) {
        return account;
      }
    }
  }

  // Run through the lubuild process
  // This happens in the build folder, NOT in the original source folder
  private async publishLuis(
    workingFolder: string,
    name: string,
    environment: string,
    language: string,
    luisEndpoint: string,
    luisAuthoringEndpoint: string,
    luisEndpointKey: string,
    luisAuthoringKey?: string,
    luisAuthoringRegion?: string,
    luisResource?: string
  ) {
    if (luisAuthoringKey && luisAuthoringRegion) {
      // Get a list of all the .lu files that are not empty
      const botFiles = await this.getFiles(workingFolder);
      const modelFiles = botFiles.filter((name) => {
        return name.endsWith('.lu') && this.notEmptyLuisModel(name);
      });

      // Identify the generated folder
      const generatedFolder = path.join(workingFolder, 'generated');

      // Identify the deployment settings file
      const deploymentSettingsPath = path.join(workingFolder, 'appsettings.deployment.json');

      // Ensure the generated folder exists
      if (!(await fs.pathExists(generatedFolder))) {
        await fs.mkdir(generatedFolder);
      }

      // Instantiate the LuBuild object from the LU parsing library
      // This object is responsible for parsing the LU files and sending them to LUIS
      const builder = new luBuild.Builder((msg) =>
        this.logger({
          status: BotProjectDeployLoggerType.DEPLOY_INFO,
          message: msg,
        })
      );

      // Pass in the list of the non-empty LU files we got above...
      const loadResult = await builder.loadContents(
        modelFiles,
        language || '',
        environment || '',
        luisAuthoringRegion || ''
      );

      // set the default endpoint
      if (!luisEndpoint) {
        luisEndpoint = `https://${luisAuthoringRegion}.api.cognitive.microsoft.com`;
      }

      // if not specified, set the authoring endpoint
      if (!luisAuthoringEndpoint) {
        luisAuthoringEndpoint = luisEndpoint;
      }

      // Perform the Lubuild process
      // This will create new luis apps for each of the luis models represented in the LU files
      const buildResult = await builder.build(
        loadResult.luContents,
        loadResult.recognizers,
        luisAuthoringKey,
        luisAuthoringEndpoint,
        name,
        environment,
        language,
        false,
        loadResult.multiRecognizers,
        loadResult.settings
      );

      // Write the generated files to the generated folder
      await builder.writeDialogAssets(buildResult, true, generatedFolder);

      this.logger({
        status: BotProjectDeployLoggerType.DEPLOY_INFO,
        message: `lubuild succeed`,
      });

      // Find any files that contain the name 'luis.settings' in them
      // These are generated by the LuBuild process and placed in the generated folder
      // These contain dialog-to-luis app id mapping
      const luisConfigFiles = (await this.getFiles(workingFolder)).filter((filename) =>
        filename.includes('luis.settings')
      );
      const luisAppIds: any = {};

      // Read in all the luis app id mappings
      for (const luisConfigFile of luisConfigFiles) {
        const luisSettings = await fs.readJson(luisConfigFile);
        Object.assign(luisAppIds, luisSettings.luis);
      }

      // Create the base LUIS config object
      const luisConfig: any = {
        endpoint: luisEndpoint,
        endpointKey: luisEndpointKey,
        authoringRegion: luisAuthoringRegion,
        authoringKey: luisAuthoringRegion,
      };

      // Copy the app IDs into the base config
      Object.assign(luisConfig, luisAppIds);

      // Update deploymentSettings with the luis config
      // TODO: This should be handled by the runtime plugin - writing to appsettings.deployment.json
      // But in this case the change here is being written into the build folder, not "original" version
      const settings: any = await fs.readJson(deploymentSettingsPath);
      settings.luis = luisConfig;
      await fs.writeJson(deploymentSettingsPath, settings, {
        spaces: 4,
      });

      // In order for the bot to use the LUIS models, we need to assign a LUIS key to the endpoint of each app
      // First step is to get a list of all the accounts available based on the given luisAuthoringKey.
      let accountList;
      try {
        // Make a call to the azureaccounts api
        // DOCS HERE: https://westus.dev.cognitive.microsoft.com/docs/services/5890b47c39e2bb17b84a55ff/operations/5be313cec181ae720aa2b26c
        // This returns a list of azure account information objects with AzureSubscriptionID, ResourceGroup, AccountName for each.
        const getAccountUri = `${luisEndpoint}/luis/api/v2.0/azureaccounts`;
        const options = {
          headers: { Authorization: `Bearer ${this.accessToken}`, 'Ocp-Apim-Subscription-Key': luisAuthoringKey },
        } as rp.RequestPromiseOptions;
        const response = await rp.get(getAccountUri, options);

        // this should include an array of account info objects
        accountList = JSON.parse(response);
      } catch (err) {
        // handle the token invalid
        const error = JSON.parse(err.error);
        if (error?.error?.message && error?.error?.message.indexOf('access token expiry') > 0) {
          throw new Error(
            `Type: ${error?.error?.code}, Message: ${error?.error?.message}, run az account get-access-token, then replace the accessToken in your configuration`
          );
        } else {
          throw err;
        }
      }
      // Extract the accoutn object that matches the expected resource name.
      // This is the name that would appear in the azure portal associated with the luis endpoint key.
      const account = this.getAccount(accountList, luisResource ? luisResource : `${name}-${environment}-luis`);

      // Assign the appropriate account to each of the applicable LUIS apps for this bot.
      // DOCS HERE: https://westus.dev.cognitive.microsoft.com/docs/services/5890b47c39e2bb17b84a55ff/operations/5be32228e8473de116325515
      for (const k in luisAppIds) {
        const luisAppId = luisAppIds[k];
        this.logger({
          status: BotProjectDeployLoggerType.DEPLOY_INFO,
          message: `Assigning to luis app id: ${luisAppId}`,
        });

        const luisAssignEndpoint = `${luisEndpoint}/luis/api/v2.0/apps/${luisAppId}/azureaccounts`;
        const options = {
          body: account,
          json: true,
          headers: { Authorization: `Bearer ${this.accessToken}`, 'Ocp-Apim-Subscription-Key': luisAuthoringKey },
        } as rp.RequestPromiseOptions;
        const response = await rp.post(luisAssignEndpoint, options);

        // TODO: Add some error handling on this API call. As it is, errors will just throw by default and be caught by the catch all try/catch in the deploy method

        this.logger({
          status: BotProjectDeployLoggerType.DEPLOY_INFO,
          message: response,
        });
      }

      // The process has now completed.
      this.logger({
        status: BotProjectDeployLoggerType.DEPLOY_INFO,
        message: 'Luis Publish Success! ...',
      });
    }
  }

  /**
   * Deploy a bot to a location
   */
  public async deploy(
    project: any,
    name: string,
    environment: string,
    language?: string,
    hostname?: string,
    luisResource?: string
  ) {
    try {
      // STEP 1: CLEAN UP PREVIOUS BUILDS
      // cleanup any previous build
      if (await fs.pathExists(this.zipPath)) {
        await fs.remove(this.zipPath);
      }

      // STEP 2: BUILD
      // run any platform specific build steps.
      // this returns a pathToArtifacts where the deployable version lives.
      const pathToArtifacts = await this.runtime.buildDeploy(this.projPath, project);

      // STEP 3: UPDATE LUIS
      // Do the LUIS build if LUIS settings are present
      // TODO: why are we reading this from disk instead of from a parameter? -- READ FROM appsettings.deployment.json
      const settings = await fs.readJSON(this.settingsPath);
      if (settings.luis) {
        const luisAuthoringKey = settings.luis.authoringKey;
        const luisAuthoringRegion = settings.luis.region;
        const luisEndpointKey = settings.luis.endpointKey;
        const luisEndpoint = settings.luis.endpoint;
        const luisAuthoringEndpoint = settings.luis.authoringEndpoint;

        if (luisAuthoringKey && luisAuthoringRegion) {
          if (!language) {
            language = 'en-us';
          }

          await this.publishLuis(
            pathToArtifacts,
            name,
            environment,
            language,
            luisEndpoint,
            luisAuthoringEndpoint,
            luisEndpointKey,
            luisAuthoringKey,
            luisAuthoringRegion,
            luisResource
          );
        }
      }

      // STEP 4: ZIP THE ASSETS
      // Build a zip file of the project
      this.logger({
        status: BotProjectDeployLoggerType.DEPLOY_INFO,
        message: 'Packing up the bot service ...',
      });
      await this.zipDirectory(pathToArtifacts, this.zipPath);
      this.logger({
        status: BotProjectDeployLoggerType.DEPLOY_INFO,
        message: 'Packing Service Success!',
      });

      // STEP 5: DEPLOY THE ZIP FILE TO AZURE
      // Deploy the zip file to the web app
      this.logger({
        status: BotProjectDeployLoggerType.DEPLOY_INFO,
        message: 'Publishing to Azure ...',
      });
      await this.deployZip(this.accessToken, this.zipPath, name, environment, hostname);
      this.logger({
        status: BotProjectDeployLoggerType.DEPLOY_SUCCESS,
        message: 'Publish To Azure Success!',
      });
    } catch (error) {
      this.logger({
        status: BotProjectDeployLoggerType.DEPLOY_ERROR,
        message: JSON.stringify(error, Object.getOwnPropertyNames(error)),
      });
      throw error;
    }
  }

  // Upload the zip file to Azure
  // DOCS HERE: https://docs.microsoft.com/en-us/azure/app-service/deploy-zip
  private async deployZip(token: string, zipPath: string, name: string, env: string, hostname?: string) {
    this.logger({
      status: BotProjectDeployLoggerType.DEPLOY_INFO,
      message: 'Retrieve publishing details ...',
    });

    const publishEndpoint = `https://${
      hostname ? hostname : name + '-' + env
    }.scm.azurewebsites.net/zipdeploy/?isAsync=true`;
    try {
      const response = await rp.post({
        uri: publishEndpoint,
        auth: {
          bearer: token,
        },
        body: fs.createReadStream(zipPath),
      });
      this.logger({
        status: BotProjectDeployLoggerType.DEPLOY_INFO,
        message: response,
      });
    } catch (err) {
      if (err.statusCode === 403) {
        throw new Error(
          `Token expired, please run az account get-access-token, then replace the accessToken in your configuration`
        );
      } else {
        throw err;
      }
    }
  }

  /*******************************************************************************************************************************/
  /* This section has to do with creating new Azure resources 
  /*******************************************************************************************************************************/

  /**
   * Write updated settings back to the settings file
   */
  private async updateDeploymentJsonFile(
    client: ResourceManagementClient,
    resourceGroupName: string,
    deployName: string,
    appId: string,
    appPwd: string
  ): Promise<any> {
    const outputs = await client.deployments.get(resourceGroupName, deployName);
    if (outputs?.properties?.outputs) {
      const outputResult = outputs.properties.outputs;
      const applicationResult = {
        MicrosoftAppId: appId,
        MicrosoftAppPassword: appPwd,
      };
      const outputObj = this.unpackObject(outputResult);

      const result = {};
      Object.assign(result, outputObj, applicationResult);
      return result;
    } else {
      return null;
    }
  }

  private getErrorMesssage(err) {
    if (err.body) {
      if (err.body.error) {
        if (err.body.error.details) {
          const details = err.body.error.details;
          let errMsg = '';
          for (const detail of details) {
            errMsg += detail.message;
          }
          return errMsg;
        } else {
          return err.body.error.message;
        }
      } else {
        return JSON.stringify(err.body, null, 2);
      }
    } else {
      return JSON.stringify(err, null, 2);
    }
  }

  private pack(scope: any) {
    return {
      value: scope,
    };
  }

  private unpackObject(output: any) {
    const unpacked: any = {};
    for (const key in output) {
      const objValue = output[key];
      if (objValue.value) {
        unpacked[key] = objValue.value;
      }
    }
    return unpacked;
  }

  /**
   * Format the parameters
   */
  private getDeploymentTemplateParam(
    appId: string,
    appPwd: string,
    location: string,
    name: string,
    shouldCreateAuthoringResource: boolean,
    shouldCreateLuisResource: boolean,
    useAppInsights: boolean,
    useCosmosDb: boolean,
    useStorage: boolean
  ) {
    return {
      appId: this.pack(appId),
      appSecret: this.pack(appPwd),
      appServicePlanLocation: this.pack(location),
      botId: this.pack(name),
      shouldCreateAuthoringResource: this.pack(shouldCreateAuthoringResource),
      shouldCreateLuisResource: this.pack(shouldCreateLuisResource),
      useAppInsights: this.pack(useAppInsights),
      useCosmosDb: this.pack(useCosmosDb),
      useStorage: this.pack(useStorage),
    };
  }

  private async readTemplateFile(templatePath: string): Promise<any> {
    return new Promise((resolve, reject) => {
      fs.readFile(templatePath, { encoding: 'utf-8' }, (err, data) => {
        if (err) {
          reject(err);
        }
        resolve(data);
      });
    });
  }

  /***********************************************************************************************
   * Azure API accessors
   **********************************************************************************************/

  /**
   * Use the Azure API to create a new resource group
   */
  private async createResourceGroup(
    client: ResourceManagementClient,
    location: string,
    resourceGroupName: string
  ): Promise<ResourceGroupsCreateOrUpdateResponse> {
    this.logger({
      status: BotProjectDeployLoggerType.PROVISION_INFO,
      message: `> Creating resource group ...`,
    });
    const param = {
      location: location,
    } as ResourceGroup;

    return await client.resourceGroups.createOrUpdate(resourceGroupName, param);
  }

  /**
   * Validate the deployment using the Azure API
   */
  private async validateDeployment(
    client: ResourceManagementClient,
    templatePath: string,
    location: string,
    resourceGroupName: string,
    deployName: string,
    templateParam: any
  ): Promise<DeploymentsValidateResponse> {
    this.logger({
      status: BotProjectDeployLoggerType.PROVISION_INFO,
      message: '> Validating Azure deployment ...',
    });
    const templateFile = await this.readTemplateFile(templatePath);
    const deployParam = {
      properties: {
        template: JSON.parse(templateFile),
        parameters: templateParam,
        mode: 'Incremental',
      },
    } as Deployment;
    return await client.deployments.validate(resourceGroupName, deployName, deployParam);
  }

  /**
   * Using an ARM template, provision a bunch of resources
   */
  private async createDeployment(
    client: ResourceManagementClient,
    templatePath: string,
    location: string,
    resourceGroupName: string,
    deployName: string,
    templateParam: any
  ): Promise<DeploymentsCreateOrUpdateResponse> {
    this.logger({
      status: BotProjectDeployLoggerType.PROVISION_INFO,
      message: `> Deploying Azure services (this could take a while)...`,
    });
    const templateFile = await this.readTemplateFile(templatePath);
    const deployParam = {
      properties: {
        template: JSON.parse(templateFile),
        parameters: templateParam,
        mode: 'Incremental',
      },
    } as Deployment;

    return await client.deployments.createOrUpdate(resourceGroupName, deployName, deployParam);
  }

  private async createApp(graphClient: GraphRbacManagementClient, displayName: string, appPassword: string) {
    const createRes = await graphClient.applications.create({
      displayName: displayName,
      passwordCredentials: [
        {
          value: appPassword,
          startDate: new Date(),
          endDate: new Date(new Date().setFullYear(new Date().getFullYear() + 2)),
        },
      ],
      availableToOtherTenants: true,
      replyUrls: ['https://token.botframework.com/.auth/web/redirect'],
    });
    return createRes;
  }

  /**
   * For more information about this api, please refer to this doc: https://docs.microsoft.com/en-us/rest/api/resources/Tenants/List
   */
  private async getTenantId() {
    if (!this.accessToken) {
      throw new Error(
        'Error: Missing access token. Please provide a non-expired Azure access token. Tokens can be obtained by running az account get-access-token'
      );
    }
    if (!this.subId) {
      throw new Error(`Error: Missing subscription Id. Please provide a valid Azure subscription id.`);
    }
    try {
      const tenantUrl = `https://management.azure.com/subscriptions/${this.subId}?api-version=2020-01-01`;
      const options = {
        headers: { Authorization: `Bearer ${this.accessToken}` },
      } as rp.RequestPromiseOptions;
      const response = await rp.get(tenantUrl, options);
      const jsonRes = JSON.parse(response);
      if (jsonRes.tenantId === undefined) {
        throw new Error(`No tenants found in the account.`);
      }
      return jsonRes.tenantId;
    } catch (err) {
      throw new Error(`Get Tenant Id Failed, details: ${this.getErrorMesssage(err)}`);
    }
  }

  /**
   * Provision a set of Azure resources for use with a bot
   */
  public async create(
    name: string,
    location: string,
    environment: string,
    appPassword: string,
    createLuisResource = true,
    createLuisAuthoringResource = true,
    createCosmosDb = true,
    createStorage = true,
    createAppInsights = true
  ) {
    if (!this.tenantId) {
      this.tenantId = await this.getTenantId();
    }
    const graphCreds = new DeviceTokenCredentials(
      this.creds.clientId,
      this.tenantId,
      this.creds.username,
      'graph',
      this.creds.environment,
      this.creds.tokenCache
    );
    const graphClient = new GraphRbacManagementClient(graphCreds, this.tenantId, {
      baseUri: 'https://graph.windows.net',
    });

    let settings: any = {};
    if (fs.existsSync(this.settingsPath)) {
      settings = await fs.readJson(this.settingsPath);
    }

    // Validate settings
    let appId = settings.MicrosoftAppId;

    // If the appId is not specified, create one
    if (!appId) {
      // this requires an app password. if one not specified, fail.
      if (!appPassword) {
        this.logger({
          status: BotProjectDeployLoggerType.PROVISION_INFO,
          message: `App password is required`,
        });
        throw new Error(`App password is required`);
      }
      this.logger({
        status: BotProjectDeployLoggerType.PROVISION_INFO,
        message: '> Creating App Registration ...',
      });

      // create the app registration
      const appCreated = await this.createApp(graphClient, name, appPassword);
      this.logger({
        status: BotProjectDeployLoggerType.PROVISION_INFO,
        message: appCreated,
      });

      // use the newly created app
      appId = appCreated.appId;
    }

    this.logger({
      status: BotProjectDeployLoggerType.PROVISION_INFO,
      message: `> Create App Id Success! ID: ${appId}`,
    });

    const resourceGroupName = `${name}-${environment}`;

    // timestamp will be used as deployment name
    const timeStamp = new Date().getTime().toString();
    const client = new ResourceManagementClient(this.creds, this.subId);

    // Create a resource group to contain the new resources
    const rpres = await this.createResourceGroup(client, location, resourceGroupName);
    this.logger({
      status: BotProjectDeployLoggerType.PROVISION_INFO,
      message: rpres,
    });

    // Caste the parameters into the right format
    const deploymentTemplateParam = this.getDeploymentTemplateParam(
      appId,
      appPassword,
      location,
      name,
      createLuisAuthoringResource,
      createLuisResource,
      createAppInsights,
      createCosmosDb,
      createStorage
    );
    this.logger({
      status: BotProjectDeployLoggerType.PROVISION_INFO,
      message: deploymentTemplateParam,
    });

    // Validate the deployment using the Azure API
    const validation = await this.validateDeployment(
      client,
      this.templatePath,
      location,
      resourceGroupName,
      timeStamp,
      deploymentTemplateParam
    );
    this.logger({
      status: BotProjectDeployLoggerType.PROVISION_INFO,
      message: validation,
    });

    // Handle validation errors
    if (validation.error) {
      this.logger({
        status: BotProjectDeployLoggerType.PROVISION_ERROR,
        message: `! Template is not valid with provided parameters. Review the log for more information.`,
      });
      this.logger({
        status: BotProjectDeployLoggerType.PROVISION_ERROR,
        message: `! Error: ${validation.error.message}`,
      });
      this.logger({
        status: BotProjectDeployLoggerType.PROVISION_ERROR,
        message: `+ To delete this resource group, run 'az group delete -g ${resourceGroupName} --no-wait'`,
      });
      this.logger({
        status: BotProjectDeployLoggerType.PROVISION_ERROR_DETAILS,
        message: validation.error.details,
      });

      throw new Error(`! Error: ${validation.error.message}`);
    }

    // Create the entire stack of resources inside the new resource group
    // this is controlled by an ARM template identified in this.templatePath
    const deployment = await this.createDeployment(
      client,
      this.templatePath,
      location,
      resourceGroupName,
      timeStamp,
      deploymentTemplateParam
    );
    this.logger({
      status: BotProjectDeployLoggerType.PROVISION_INFO,
      message: deployment,
    });

    // Handle errors
    if (deployment._response.status != 200) {
      this.logger({
        status: BotProjectDeployLoggerType.PROVISION_ERROR,
        message: `! Template is not valid with provided parameters. Review the log for more information.`,
      });
      this.logger({
        status: BotProjectDeployLoggerType.PROVISION_ERROR,
        message: `! Error: ${validation.error}`,
      });
      this.logger({
        status: BotProjectDeployLoggerType.PROVISION_ERROR,
        message: `+ To delete this resource group, run 'az group delete -g ${resourceGroupName} --no-wait'`,
      });

      throw new Error(`! Error: ${validation.error}`);
    }

    // If application insights created, update the application insights settings in azure bot service
    if (createAppInsights) {
      this.logger({
        status: BotProjectDeployLoggerType.PROVISION_INFO,
        message: `> Linking Application Insights settings to Bot Service ...`,
      });

      const appinsightsClient = new ApplicationInsightsManagementClient(this.creds, this.subId);
      const appComponents = await appinsightsClient.components.get(resourceGroupName, resourceGroupName);
      const appinsightsId = appComponents.appId;
      const appinsightsInstrumentationKey = appComponents.instrumentationKey;
      const apiKeyOptions = {
        name: `${resourceGroupName}-provision-${timeStamp}`,
        linkedReadProperties: [
          `/subscriptions/${this.subId}/resourceGroups/${resourceGroupName}/providers/microsoft.insights/components/${resourceGroupName}/api`,
          `/subscriptions/${this.subId}/resourceGroups/${resourceGroupName}/providers/microsoft.insights/components/${resourceGroupName}/agentconfig`,
        ],
        linkedWriteProperties: [
          `/subscriptions/${this.subId}/resourceGroups/${resourceGroupName}/providers/microsoft.insights/components/${resourceGroupName}/annotations`,
        ],
      };
      const appinsightsApiKeyResponse = await appinsightsClient.aPIKeys.create(
        resourceGroupName,
        resourceGroupName,
        apiKeyOptions
      );
      const appinsightsApiKey = appinsightsApiKeyResponse.apiKey;

      this.logger({
        status: BotProjectDeployLoggerType.PROVISION_INFO,
        message: `> AppInsights AppId: ${appinsightsId} ...`,
      });
      this.logger({
        status: BotProjectDeployLoggerType.PROVISION_INFO,
        message: `> AppInsights InstrumentationKey: ${appinsightsInstrumentationKey} ...`,
      });
      this.logger({
        status: BotProjectDeployLoggerType.PROVISION_INFO,
        message: `> AppInsights ApiKey: ${appinsightsApiKey} ...`,
      });

      if (appinsightsId && appinsightsInstrumentationKey && appinsightsApiKey) {
        const botServiceClient = new AzureBotService(this.creds, this.subId);
        const botCreated = await botServiceClient.bots.get(resourceGroupName, name);
        if (botCreated.properties) {
          botCreated.properties.developerAppInsightKey = appinsightsInstrumentationKey;
          botCreated.properties.developerAppInsightsApiKey = appinsightsApiKey;
          botCreated.properties.developerAppInsightsApplicationId = appinsightsId;
          const botUpdateResult = await botServiceClient.bots.update(resourceGroupName, name, botCreated);

          if (botUpdateResult._response.status != 200) {
            this.logger({
              status: BotProjectDeployLoggerType.PROVISION_ERROR,
              message: `! Something went wrong while trying to link Application Insights settings to Bot Service Result: ${JSON.stringify(
                botUpdateResult
              )}`,
            });
            throw new Error(`Linking Application Insights Failed.`);
          }
          this.logger({
            status: BotProjectDeployLoggerType.PROVISION_INFO,
            message: `> Linking Application Insights settings to Bot Service Success!`,
          });
        } else {
          this.logger({
            status: BotProjectDeployLoggerType.PROVISION_WARNING,
            message: `! The Bot doesn't have a keys properties to update.`,
          });
        }
      }
    }

    // Validate that everything was successfully created.
    // Then, update the settings file with information about the new resources
    const updateResult = await this.updateDeploymentJsonFile(client, resourceGroupName, timeStamp, appId, appPassword);
    this.logger({
      status: BotProjectDeployLoggerType.PROVISION_INFO,
      message: updateResult,
    });

    // Handle errors
    if (!updateResult) {
      const operations = await client.deploymentOperations.list(resourceGroupName, timeStamp);
      if (operations) {
        const failedOperations = operations.filter((value) => value?.properties?.statusMessage.error !== null);
        if (failedOperations) {
          failedOperations.forEach((operation) => {
            switch (operation?.properties?.statusMessage.error.code) {
              case 'MissingRegistrationForLocation':
                this.logger({
                  status: BotProjectDeployLoggerType.PROVISION_ERROR,
                  message: `! Deployment failed for resource of type ${operation?.properties?.targetResource?.resourceType}. This resource is not avaliable in the location provided.`,
                });
                break;
              default:
                this.logger({
                  status: BotProjectDeployLoggerType.PROVISION_ERROR,
                  message: `! Deployment failed for resource of type ${operation?.properties?.targetResource?.resourceType}.`,
                });
                this.logger({
                  status: BotProjectDeployLoggerType.PROVISION_ERROR,
                  message: `! Code: ${operation?.properties?.statusMessage.error.code}.`,
                });
                this.logger({
                  status: BotProjectDeployLoggerType.PROVISION_ERROR,
                  message: `! Message: ${operation?.properties?.statusMessage.error.message}.`,
                });
                break;
            }
          });
        }
      } else {
        this.logger({
          status: BotProjectDeployLoggerType.PROVISION_ERROR,
          message: `! Deployment failed. Please refer to the log file for more information.`,
        });
      }
    }
    this.logger({
      status: BotProjectDeployLoggerType.PROVISION_SUCCESS,
      message: `+ To delete this resource group, run 'az group delete -g ${resourceGroupName} --no-wait'`,
    });
    return updateResult;
  }

  /**
   * createAndDeploy
   * provision the Azure resources AND deploy a bot to those resources
   */
  // public async createAndDeploy(
  //   name: string,
  //   location: string,
  //   environment: string,
  //   appPassword: string,
  //   luisAuthoringKey?: string,
  //   luisAuthoringRegion?: string
  // ) {
  //   await this.create(name, location, environment, appPassword);
  //   // await this.deploy(name, environment, luisAuthoringKey, luisAuthoringRegion);
  // }
}
