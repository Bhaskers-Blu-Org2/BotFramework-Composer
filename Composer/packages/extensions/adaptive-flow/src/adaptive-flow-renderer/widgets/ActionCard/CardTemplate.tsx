// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/** @jsx jsx */
import { jsx } from '@emotion/core';
import { FC, ReactNode } from 'react';
import { TextDiv } from '@bfc/ui-shared';

import { StandardNodeWidth } from '../../constants/ElementSizes';
import { ObiColors } from '../../constants/ElementColors';
import { ArrowLine } from '../../components/ArrowLine';

import { HeaderCSS, BodyCSS, FooterCSS, SeparateLineCSS, CardContainerCSS } from './CardTemplate.style';

export interface CardTemplateProps {
  header: ReactNode;
  body?: ReactNode;
  footer?: ReactNode;
  disabled?: boolean;
  onClick?: (event: React.MouseEvent<HTMLDivElement, MouseEvent>) => void;
  onClickHeader?: (event: React.MouseEvent<HTMLDivElement, MouseEvent>) => void;
  onClickBody?: (event: React.MouseEvent<HTMLDivElement, MouseEvent>) => void;
  onClickFooter?: (event: React.MouseEvent<HTMLDivElement, MouseEvent>) => void;
}

export const CardTemplate: FC<CardTemplateProps> = ({
  header,
  body,
  footer,
  disabled,
  onClick,
  onClickHeader,
  onClickBody,
  onClickFooter,
}) => {
  const renderHeader = (header: ReactNode) => (
    <div className="CardNode__Header" css={HeaderCSS} onClick={onClickHeader}>
      {header}
    </div>
  );

  const renderBody = (body: ReactNode) => (
    <div className="CardNode__Body" css={BodyCSS} onClick={onClickBody}>
      <TextDiv css={{ width: '100%' }}>{body}</TextDiv>
    </div>
  );

  const renderFooter = (footer: ReactNode) => (
    <div className="CardNode__Footer" css={FooterCSS} onClick={onClickFooter}>
      <TextDiv css={{ width: '100%' }}>{footer}</TextDiv>
    </div>
  );

  const renderSeparateline = () => (
    <div className="Separator" css={SeparateLineCSS}>
      <ArrowLine arrowsize={8} color={ObiColors.AzureGray3} width={StandardNodeWidth} />
    </div>
  );

  // If body is null but footer not null, show footer as body.
  const [displayedBody, displayedFooter] = [body, footer].filter((x) => x !== undefined && x !== null);
  const showFooter = displayedFooter !== undefined;
  return (
    <div
      className="CardNode"
      css={CardContainerCSS}
      onClick={
        onClick
          ? (e) => {
              e.stopPropagation();
              onClick(e);
            }
          : undefined
      }
    >
      {renderHeader(header)}
      {renderBody(displayedBody)}
      {showFooter ? renderSeparateline() : null}
      {showFooter ? renderFooter(footer) : null}
    </div>
  );
};
