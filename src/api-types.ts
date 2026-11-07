// Shapes returned by the Sites MCP tools (only the fields the CLI relies on).

export interface SiteRecord {
  id?: string;
  project_id?: string;
  slug?: string;
  title?: string;
  url?: string | null;
  current_live_url?: string | null;
  expected_url?: string | null;
  current_preview_url?: string | null;
  access_mode?: string;
  created_at?: string;
  updated_at?: string;
  latest_version_number?: number;
  mcp_connection?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface ListSitesResult {
  items?: SiteRecord[];
  cursor?: string | null;
}

export interface SiteVersionRecord {
  id?: string;
  project_id?: string;
  version_number?: number;
  source?: { commit_sha?: string };
  archive_storage?: Record<string, unknown>;
  deployment_id?: string | null;
  created_at?: string;
  [key: string]: unknown;
}

export interface ListVersionsResult {
  items?: SiteVersionRecord[];
  cursor?: string | null;
}

export interface CustomDomainRecord {
  id?: string;
  hostname?: string;
  status?: string;
  provider_status?: string;
  ssl_status?: string;
  [key: string]: unknown;
}

export interface ListCustomDomainsResult {
  items?: CustomDomainRecord[];
}

export interface DeploymentRecord {
  id?: string;
  project_id?: string;
  version_id?: string;
  status?: string;
  url?: string | null;
  failure_message?: string | null;
  env_set_revision?: number;
  [key: string]: unknown;
}

export interface EnvironmentEntry {
  key?: string;
  value?: string | null;
  is_secret?: boolean;
  type?: string;
  [key: string]: unknown;
}

export interface EnvironmentResult {
  project_id?: string;
  entries?: EnvironmentEntry[];
  revision?: number;
  updated_at?: string;
  [key: string]: unknown;
}

export interface WorkerLogsResult {
  events?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface AnalyticsOverview {
  [key: string]: unknown;
}

export interface CreateSiteResult extends SiteRecord {
  expected_url?: string | null;
  source_repository_credential?: SourceCredential | null;
}

export interface SourceCredential {
  provider?: string;
  repository?: string;
  branch?: string;
  remote_url?: string;
  token?: string;
  token_expires_at?: string;
  auth_mode?: string;
  publish_on_push_accepted?: boolean;
  [key: string]: unknown;
}
