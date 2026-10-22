type RemoteWebHost = "github" | "gitlab" | "bitbucket";

export type RemoteWebInfo = {
  host: RemoteWebHost;
  hostname: string;
  owner: string;
  repo: string;
  baseUrl: string;
};

const SUPPORTED_HOSTS: Record<string, RemoteWebHost> = {
  "github.com": "github",
  "www.github.com": "github",
  "gitlab.com": "gitlab",
  "www.gitlab.com": "gitlab",
  "bitbucket.org": "bitbucket",
  "www.bitbucket.org": "bitbucket",
};

// English defaults, kept so the helper stands alone (and stays unit-testable);
// callers that render the label pass the translated strings instead.
const DEFAULT_HOST_LABELS: Record<RemoteWebHost, string> = {
  github: "View on GitHub",
  gitlab: "View on GitLab",
  bitbucket: "View on Bitbucket",
};

export function parseRemoteWebUrl(raw: string | null | undefined): RemoteWebInfo | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let hostname: string;
  let pathname: string;

  const scpMatch = trimmed.match(/^([^@]+@)?([^:]+):(.+)$/);
  if (scpMatch && !/^https?:\/\//i.test(trimmed) && !trimmed.startsWith("/")) {
    hostname = scpMatch[2];
    pathname = scpMatch[3];
  } else {
    try {
      const url = new URL(trimmed);
      hostname = url.hostname;
      pathname = url.pathname;
    } catch {
      return null;
    }
  }

  const host = SUPPORTED_HOSTS[hostname.toLowerCase()];
  if (!host) return null;

  const parts = pathname
    .replace(/^\//, "")
    .replace(/\.git$/i, "")
    .split("/")
    .filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0];
  const repo = parts[1];
  return {
    host,
    hostname: hostname.toLowerCase(),
    owner,
    repo,
    baseUrl: `https://${hostname.toLowerCase()}/${owner}/${repo}`,
  };
}

export function commitWebUrl(info: RemoteWebInfo, sha: string): string {
  switch (info.host) {
    case "github":
      return `${info.baseUrl}/commit/${sha}`;
    case "gitlab":
      return `${info.baseUrl}/-/commit/${sha}`;
    case "bitbucket":
      return `${info.baseUrl}/commits/${sha}`;
  }
}

/** Button label for the host's commit page, e.g. `View on GitHub`. */
export function hostLabel(
  info: RemoteWebInfo,
  labels: Record<RemoteWebHost, string> = DEFAULT_HOST_LABELS,
): string {
  return labels[info.host];
}
