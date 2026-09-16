/** The GitLab service-account username (and thus fork namespace) for an
 *  identity. Single source of truth: the provisioner creates the account
 *  with this name, and the fork-namespace policy pins commits to it. */
export const gitlabServiceAccountUsername = (agentId: string): string => `agent-${agentId}`;
