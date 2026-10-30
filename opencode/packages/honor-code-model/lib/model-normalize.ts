/** Pure model-ref helpers shared by honor-code-model and verify. */

export type NormalizedModel = {
  providerID: string
  id: string
  variant?: string
}

/**
 * Normalize a model string or object into Model.Ref shape
 * (`providerID` + `id`).
 */
export function normalizeModel(
  model: string | { providerID: string; modelID?: string; id?: string; variant?: string },
): NormalizedModel {
  if (typeof model === "string") {
    const slash = model.indexOf("/")
    if (slash === -1) {
      return { providerID: model, id: model }
    }
    return {
      providerID: model.slice(0, slash),
      id: model.slice(slash + 1),
    }
  }
  const id = model.id ?? model.modelID ?? ""
  const out: NormalizedModel = {
    providerID: model.providerID,
    id,
  }
  if (model.variant !== undefined) out.variant = model.variant
  return out
}

export function modelsEqual(a: NormalizedModel, b: NormalizedModel): boolean {
  return (
    a.providerID === b.providerID &&
    a.id === b.id &&
    (a.variant ?? "") === (b.variant ?? "")
  )
}
