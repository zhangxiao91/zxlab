declare global {
  interface Env {
    GITHUB_TOKEN?: string;
    PAGES_DEPLOY_HOOK_URL?: string;
  }
}

export {};
