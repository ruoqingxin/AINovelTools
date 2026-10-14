import { describe, expect, it, vi } from "vitest";
import { workspaceThemePlugin } from "../../workspace-theme-plugin";

function transform(prop: string, value: string) {
  const plugin = workspaceThemePlugin().prepare();
  const root = { append: vi.fn() };
  const declaration = { prop, value };
  plugin.Declaration(declaration);
  plugin.OnceExit(root);
  return { plugin, root, declaration };
}
describe("workspace theme CSS tokens", () => {
  it("retains exact light fallbacks and supplies dark text, surfaces and semantic colors", () => {
    for (const [prop, color, role] of [
      ["color", "#303640", "text"], ["background", "white", "surface"],
      ["background", "#eaf1fc", "blue-tint"], ["color", "#245bb3", "blue-text"],
      ["color", "#aa2233", "red-text"], ["color", "white", "on-accent"],
      ["color", "#1d2d46", "text"], ["color", "#60728c", "muted"],
      ["--surface-subtle", "#f7f8f6", "subtle"],
    ]) {
      const { declaration, root } = transform(prop!, color!);
      expect(declaration.value).toBe(`var(--theme-${role}, ${color})`);
      expect(root.append).toHaveBeenCalledWith(expect.objectContaining({ selector: ':root[data-theme="dark"]' }));
    }
  });
  it("preserves alpha, quoted values and URLs without changing sizing or content", () => {
    expect(transform("box-shadow", "0 1px 3px #18243418").declaration.value).toBe("0 1px 3px var(--theme-shadow-18, #18243418)");
    expect(transform("background", 'url("white.svg#abcdef") #fff').declaration.value)
      .toBe('url("white.svg#abcdef") var(--theme-surface, #fff)');
    expect(transform("background", 'url("var(--accent).png") var(--accent)').declaration.value)
      .toBe('url("var(--accent).png") var(--theme-action, var(--accent))');
    expect(transform("content", '"white"').declaration.value).toBe('"white"');
    expect(transform("font-family", '"black"').declaration.value).toBe('"black"');
  });
  it("themes translucent RGB surfaces, shadows and percentage channels", () => {
    expect(transform("background", "rgba(255, 255, 255, .72)").declaration.value)
      .toBe("var(--theme-surface-b8, rgba(255, 255, 255, .72))");
    expect(transform("box-shadow", "0 1px 4px rgba(55,88,132,.12)").declaration.value)
      .toBe("0 1px 4px var(--theme-shadow-1f, rgba(55,88,132,.12))");
    expect(transform("background", "rgb(100% 100% 100% / 80%)").declaration.value)
      .toBe("var(--theme-surface-cc, rgb(100% 100% 100% / 80%))");
    expect(transform("color", "rgb(var(--channels))").declaration.value).toBe("rgb(var(--channels))");
  });
  it("separates action fills from readable accent text and is idempotent", () => {
    const { declaration, plugin } = transform("background", "var(--accent-strong)");
    expect(declaration.value).toBe("var(--theme-action-hover, var(--accent-strong))");
    plugin.Declaration(declaration);
    expect(declaration.value).toBe("var(--theme-action-hover, var(--accent-strong))");
    expect(transform("background", "var(--settings-accent)").declaration.value)
      .toBe("var(--theme-action, var(--settings-accent))");
  });
  it("keeps tokens isolated when separate CSS roots are processed concurrently", () => {
    const plugin = workspaceThemePlugin();
    const firstVisitors = plugin.prepare(), secondVisitors = plugin.prepare();
    const first = { append: vi.fn() }, second = { append: vi.fn() };
    firstVisitors.Declaration({ prop: "color", value: "#aa2233" });
    secondVisitors.Declaration({ prop: "background", value: "white" });
    firstVisitors.OnceExit(first); secondVisitors.OnceExit(second);
    expect(first.append.mock.calls[0]![0].nodes.map((node: { prop: string }) => node.prop)).toEqual(["--theme-red-text"]);
    expect(second.append.mock.calls[0]![0].nodes.map((node: { prop: string }) => node.prop)).toEqual(["--theme-surface"]);
  });
});
