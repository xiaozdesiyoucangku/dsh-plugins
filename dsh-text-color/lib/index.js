/**
 * Host half of dsh-text-color.
 *
 * The feature is entirely browser-side: the client half reads the user's
 * overrides and folds them into the active theme through `ctx.theme.overrideTokens`.
 * This host entry exists so the Loader has an enabled plugin whose `dsh.client`
 * declaration the module system can turn into a browser bundle — without it the
 * client half is never composed into the boot graph.
 */

/** No host-side behaviour: nothing here is visible to the model or the session. */
function apply() {}

export { apply };
