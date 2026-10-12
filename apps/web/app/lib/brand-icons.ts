/**
 * Connectors' brand marks, from Simple Icons, by connector id
 * (@g1t/contracts/connectors). A connector without one here keeps its
 * letters. Named imports, so only these icons are bundled.
 */
import {
  type SimpleIcon,
  si1password,
  siAnthropic,
  siAsana,
  siAtlassian,
  siBetterstack,
  siBitbucket,
  siBox,
  siBuildkite,
  siCircleci,
  siClickup,
  siCloudflare,
  siCoda,
  siDatadog,
  siDeepseek,
  siDiscord,
  siDocker,
  siDropbox,
  siFigma,
  siFlydotio,
  siGithub,
  siGitlab,
  siGmail,
  siGooglebigquery,
  siGooglecalendar,
  siGooglecloud,
  siGoogledocs,
  siGoogledrive,
  siGooglegemini,
  siGooglemeet,
  siGrafana,
  siHubspot,
  siHuggingface,
  siIntercom,
  siJira,
  siKubernetes,
  siLinear,
  siMiro,
  siMistralai,
  siModelcontextprotocol,
  siNeon,
  siNetlify,
  siNewrelic,
  siNotion,
  siOkta,
  siOpenrouter,
  siOpsgenie,
  siPagerduty,
  siPaypal,
  siPostgresql,
  siPosthog,
  siSentry,
  siShortcut,
  siSnowflake,
  siSnyk,
  siStorybook,
  siStripe,
  siSupabase,
  siTrello,
  siVercel,
  siZapier,
  siZendesk,
  siZoom,
} from "simple-icons";

const BRAND_ICONS: Record<string, SimpleIcon> = {
  github: siGithub,
  "github-mcp": siGithub,
  gitlab: siGitlab,
  bitbucket: siBitbucket,
  circleci: siCircleci,
  buildkite: siBuildkite,
  "docker-hub": siDocker,
  linear: siLinear,
  "linear-mcp": siLinear,
  jira: siJira,
  asana: siAsana,
  shortcut: siShortcut,
  clickup: siClickup,
  trello: siTrello,
  discord: siDiscord,
  zoom: siZoom,
  "google-meet": siGooglemeet,
  "google-calendar": siGooglecalendar,
  gmail: siGmail,
  notion: siNotion,
  atlassian: siAtlassian,
  "google-docs": siGoogledocs,
  zapier: siZapier,
  coda: siCoda,
  sentry: siSentry,
  "sentry-mcp": siSentry,
  datadog: siDatadog,
  pagerduty: siPagerduty,
  opsgenie: siOpsgenie,
  grafana: siGrafana,
  "new-relic": siNewrelic,
  "better-stack": siBetterstack,
  cloudflare: siCloudflare,
  "cloudflare-docs": siCloudflare,
  "google-cloud": siGooglecloud,
  vercel: siVercel,
  netlify: siNetlify,
  "fly-io": siFlydotio,
  kubernetes: siKubernetes,
  anthropic: siAnthropic,
  gemini: siGooglegemini,
  mistral: siMistralai,
  deepseek: siDeepseek,
  openrouter: siOpenrouter,
  mcp: siModelcontextprotocol,
  "hugging-face": siHuggingface,
  postgresql: siPostgresql,
  snowflake: siSnowflake,
  bigquery: siGooglebigquery,
  posthog: siPosthog,
  supabase: siSupabase,
  neon: siNeon,
  zendesk: siZendesk,
  intercom: siIntercom,
  hubspot: siHubspot,
  stripe: siStripe,
  paypal: siPaypal,
  figma: siFigma,
  miro: siMiro,
  storybook: siStorybook,
  okta: siOkta,
  "1password": si1password,
  snyk: siSnyk,
  "google-drive": siGoogledrive,
  dropbox: siDropbox,
  box: siBox,
};

/** A connector's brand mark: its SVG path, and the colour to draw it in. */
export type BrandIcon = { path: string; title: string; color: string | null };

/** Relative luminance of a `RRGGBB` colour, 0 (black) to 1 (white). */
function luminance(hex: string): number {
  const [r, g, b] = [0, 2, 4].map((at) => {
    const channel = parseInt(hex.slice(at, at + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/**
 * The brand mark for connector `id`, or null. `color` is the brand's own,
 * or null when it is black or nearly (GitHub, Notion, Vercel): those are
 * drawn in the text colour, so they read on the dark theme as on the light.
 */
export function brandIcon(id: string): BrandIcon | null {
  const icon = BRAND_ICONS[id];
  if (!icon) return null;
  return { path: icon.path, title: icon.title, color: luminance(icon.hex) < 0.04 ? null : `#${icon.hex}` };
}
