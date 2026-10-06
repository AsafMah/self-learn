export const createCanvas = (declaration) => declaration;
export async function joinSession(options) {
    const host = globalThis[Symbol.for("self-learn-test-host")];
    if (!host) throw new Error("No isolated self-learn test host");
    host.options = options;
    return host.session;
}
