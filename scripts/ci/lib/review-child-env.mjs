/**
 * Build a minimal env for the trusted Grok companion child process.
 *
 * Security: deliberately omits GITHUB_TOKEN, GH_TOKEN, and GROK_AUTH_JSON
 * so review auth and GitHub write credentials never coexist in one process.
 *
 * @param {object} opts
 * @param {string} opts.authPath - Path to staged auth.json (GROK_AUTH_PATH)
 * @param {string} [opts.runId] - Session id (GITHUB_RUN_ID or fallback)
 * @param {string} [opts.pathEnv] - PATH
 * @param {string} [opts.home]
 * @param {string} [opts.user]
 * @param {string} [opts.logname]
 * @param {string} [opts.tmpdir]
 * @param {string} [opts.tmp]
 * @param {string} [opts.temp]
 * @param {string} [opts.lang]
 * @param {string} [opts.runnerTemp] - RUNNER_TEMP or os.tmpdir() for plugin data
 * @param {string|number} [opts.pid] - used to uniquify CLAUDE_PLUGIN_DATA
 * @param {string} [opts.grokBin] - optional GROK_BIN
 * @returns {Record<string, string>}
 */
export function buildReviewChildEnv({
  authPath,
  runId,
  pathEnv,
  home,
  user,
  logname,
  tmpdir,
  tmp,
  temp,
  lang,
  runnerTemp,
  pid,
  grokBin
}) {
  if (!authPath || !String(authPath).trim()) {
    throw new Error("buildReviewChildEnv: authPath is required");
  }
  const pluginBase = runnerTemp || tmpdir || tmp || temp || "/tmp";
  const processId = pid ?? process.pid;
  const env = {
    PATH: pathEnv ?? "",
    HOME: home ?? "",
    USER: user ?? "",
    LOGNAME: logname ?? "",
    TMPDIR: tmpdir ?? "",
    TMP: tmp ?? "",
    TEMP: temp ?? "",
    LANG: lang ?? "",
    GROK_AUTH_PATH: authPath,
    CLAUDE_PLUGIN_DATA: `${pluginBase}/grok-ci-plugin-data-${processId}`,
    GROK_COMPANION_HOST: "ci",
    GROK_COMPANION_HOST_SESSION_ID: runId || `ci-${processId}`
  };
  if (grokBin) env.GROK_BIN = grokBin;
  // Explicitly do not set GITHUB_TOKEN / GH_TOKEN / GROK_AUTH_JSON
  return env;
}
