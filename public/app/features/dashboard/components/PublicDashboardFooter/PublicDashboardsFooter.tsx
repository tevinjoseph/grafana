import { css } from '@emotion/css';
import React from 'react';

import { GrafanaTheme2 } from '@grafana/data';
import { useStyles2, useTheme2 } from '@grafana/ui';

export interface PublicDashboardCfg {
  footerHide: boolean;
  footerText: React.ReactNode;
  footerLogo: string;
  footerLink: string;
  headerLogoShow: boolean;
}

export const PublicDashboardFooter = function () {
  const styles = useStyles2(getStyles);
  const conf = useGetPublicDashboardFooterConfig();

  return conf.footerHide ? null : (
    <div className={styles.footer}>
      <a className={styles.link} href={conf.footerLink} target="_blank" rel="noreferrer noopener">
        {conf.footerText} <img className={styles.logoImg} alt="" src={conf.footerLogo} />
      </a>
    </div>
  );
};

export function setPublicDashboardFooterConfigFn(fn: typeof useGetPublicDashboardFooterConfig) {
  useGetPublicDashboardFooterConfig = fn;
}
export let useGetPublicDashboardFooterConfig = (): PublicDashboardCfg => {
  const theme = useTheme2();
  const styles = useStyles2(getStyles);

  return {
    footerHide: false,
    footerText: <span className={styles.text}>Powered by</span>,
    footerLogo: theme.isDark ? 'public/img/grafana_text_logo_light.svg' : 'public/img/grafana_text_logo_dark.svg',
    footerLink: 'https://grafana.com/',
    headerLogoShow: true,
  };
};

const getStyles = (theme: GrafanaTheme2) => ({
  footer: css({
    display: 'flex',
    justifyContent: 'end',
    height: '30px',
    padding: theme.spacing(0, 2, 0, 1),
  }),
  link: css({
    display: 'flex',
    alignItems: 'center',
  }),
  text: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.body.fontSize,
  }),
  logoImg: css({
    height: '16px',
    marginLeft: theme.spacing(0.5),
  }),
});
