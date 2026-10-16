import { Plugin } from "@opencode/plugin";

console.log("[honor-code-model] plugin loaded");

function normalizeModel(model: string | { providerID: string; modelID?: string; id?: string }) {
  if (typeof model === "string") {
    const slash = model.indexOf("/");
    if (slash === -1) {
      return { providerID: model, modelID: model };
    }
    return {
      providerID: model.slice(0, slash),
      modelID: model.slice(slash + 1),
    };
  }
  return {
    providerID: model.providerID,
    modelID: model.modelID ?? model.id ?? "",
  };
}

export default Plugin.define({
  id: "honor-code-model",
  async setup(ctx) {
    console.log("[honor-code-model] setup called");
    const controller = new AbortController();

    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (event.type !== "session.created") continue;

        const sessionID = event.properties.sessionID;
        console.log("[honor-code-model] session.created", {
          sessionID,
        });

        const info = await ctx.session.get({ sessionID });
        console.log("[honor-code-model] session.get", {
          sessionID,
          parentID: info.parentID,
          agent: info.agent,
        });

        if (info.parentID) {
          const agent = await ctx.agent.get({ agentID: info.agent });
          console.log("[honor-code-model] agent.get result", agent);
          if (agent?.model) {
            const model = normalizeModel(agent.model);
            console.log("[honor-code-model] switchModel call", {
              sessionID,
              model,
            });
            await ctx.session.switchModel({
              sessionID,
              model,
            });
          }
        }
      }
    })();

    return () => controller.abort();
  },
});
