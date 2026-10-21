import { describe, expect, it } from "vitest";
import { preparationStatus } from "./creation-preparation";
import { outlineReviewChecks, planningReviewChanges, planningReviewIsCurrent, readPlanningReview, withPlanningReview } from "./planning-review";
import { emptyPlanningSection } from "./use-planning-draft";

const basis = { ...emptyPlanningSection("seed-premise"), content: "邮差追查来信", storyState: "CONFIRMED" as const, version: 3 };
function reviewed() {
  const draft = { ...emptyPlanningSection("plan-node:outline"), content: "开局、选择、后果与高潮", references: ["discussion:source"], version: 4 };
  return { ...draft, storyState: "CONFIRMED" as const, references: withPlanningReview(draft, outlineReviewChecks, [basis]), version: 5 };
}
describe("author planning review records", () => {
  it("records exact source versions and preserves existing references", () => {
    const section = reviewed();
    expect(section.references).toContain("discussion:source");
    expect(readPlanningReview(section)).toEqual({ sectionVersion: 5, checks: outlineReviewChecks, basis: [{ id: basis.id, version: 3 }] });
    expect(planningReviewIsCurrent(section, [basis])).toBe(true);
  });
  it("withdraws confirmation when the reviewed basis changes or disappears", () => {
    const section = reviewed();
    expect(preparationStatus(section, [basis])).toBe("confirmed");
    expect(planningReviewChanges(section, [{ ...basis, version: 4 }])).toEqual([basis.id]);
    expect(preparationStatus(section, [{ ...basis, version: 4 }])).toBe("review");
    expect(preparationStatus(section, [])).toBe("review");
    expect(section.content).toBe("开局、选择、后果与高潮");
  });
  it("rejects unresolved or withdrawn basis and edits made outside the review editor", () => {
    expect(planningReviewIsCurrent(reviewed(), [{ ...basis, pendingContent: "尚待确认的修改" }])).toBe(false);
    expect(planningReviewIsCurrent(reviewed(), [{ ...basis, storyState: "DEFERRED" }])).toBe(false);
    expect(planningReviewIsCurrent({ ...reviewed(), version: 6 }, [basis])).toBe(false);
  });
  it("replaces only its own record and retains legacy formal content", () => {
    const section = reviewed();
    const references = withPlanningReview(section, outlineReviewChecks, [{ ...basis, version: 4 }]);
    expect(references).toHaveLength(2);
    expect(references).toContain("discussion:source");
    expect(preparationStatus({ ...basis, references: [] }, [])).toBe("confirmed");
    expect(readPlanningReview({ ...basis, references: ["author-planning-review:v1:{invalid"] })).toBeNull();
    expect(readPlanningReview({ ...basis, references: ['author-planning-review:v1:{"basis":[null]}'] })).toBeNull();
  });
});
