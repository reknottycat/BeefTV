// Model choice belongs to the current project/use, not to a catalog request.
// Availability refreshes must not replace an explicit choice with a cloud default.
export function projectGenerationModelSelection(current: string, initial: string, contextChanged: boolean) {
    return contextChanged ? initial : current || initial;
}
