import { css, cx } from '@emotion/css';
import React from 'react';

import { GrafanaTheme2, renderMarkdown } from '@grafana/data';
import { useStyles2 } from '@grafana/ui';

export interface Props extends React.HTMLAttributes<HTMLDivElement> {
  children?: React.ReactNode;
  markdown?: string;
  onRemove?: () => void;
  styleOverrides?: Record<string, any>;
}

export const OperationRowHelp = React.memo(
  React.forwardRef<HTMLDivElement, Props>(({ className, children, markdown, styleOverrides, onRemove, ...otherProps }, ref) => {
    const styles = useStyles2((theme) => getStyles(theme, styleOverrides?.borderTop));

    return (
      <div className={cx(styles.wrapper, className)} {...otherProps} ref={ref}>
        {markdown && markdownHelper(markdown)}
        {children}
      </div>
    );
  })
);

function markdownHelper(markdown: string) {
  const helpHtml = renderMarkdown(markdown);
  return <div className="markdown-html" dangerouslySetInnerHTML={{ __html: helpHtml }} />;
}

OperationRowHelp.displayName = 'OperationRowHelp';

const getStyles = (theme: GrafanaTheme2, borderTop?: boolean) => {
  const borderRadius = theme.shape.radius.default;
  // This wrapper is also being used in the TransformationEditorHelperModal.tsx, which requires a border-top.
  const borderSettings = `2px solid ${theme.colors.background.secondary}`;

  return {
    wrapper: css`
      padding: ${theme.spacing(2)};
      border: ${borderSettings};
      border-top: ${borderTop ? borderSettings : 'none'};
      border-radius: 0 0 ${borderRadius} ${borderRadius};
      position: relative;
      top: -4px;
    `,
  };
};
