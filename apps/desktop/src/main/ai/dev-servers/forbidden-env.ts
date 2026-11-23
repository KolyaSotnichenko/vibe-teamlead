/**
 * Variables nobody but the app sets for a process it starts for a project: they change what
 * a command runs or loads, which the command check could not see. For agents' dev servers
 * (tools/app-tools/dev-server.ts) and for a project's preview recipe (preview/recipe.ts).
 */
export const FORBIDDEN_ENV = /^(PATH|NODE_OPTIONS|NODE_PATH|LD_.*|DYLD_.*|BASH_ENV|BASH_FUNC_.*|ENV|SHELL|HOME|NPM_CONFIG_.*|GIT_.*|PYTHON.*|RUBY.*|PERL.*|JAVA_.*)$/i;
