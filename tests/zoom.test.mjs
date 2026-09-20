// App-wide zoom: stepping/reset, and that applying zoom invokes the native command
// and re-measures every open tab's CodeMirror instance.
import test from "node:test";
import assert from "node:assert/strict";
import { freshApp } from "./harness.mjs";

function stubInvoke({ tauri }) {
  const calls = [];
  tauri.core.invoke = async (cmd, payload) => {
    calls.push({ cmd, payload });
  };
  return calls;
}

function tabWithEditor({ app }) {
  let refreshCalls = 0;
  const tab = { editor: { refresh: () => refreshCalls++ } };
  app.state.tabs.push(tab);
  return () => refreshCalls;
}

test("applyZoom", async (t) => {
  await t.test("invokes set_zoom with the persisted factor and refreshes every tab's editor", async () => {
    const ctx = freshApp();
    const { window, app } = ctx;
    const calls = stubInvoke(ctx);
    window.localStorage.setItem(app.ZOOM_KEY, "1.25");
    const getRefreshCalls = tabWithEditor(ctx);

    await window.applyZoom();

    // `payload` is a cross-realm object literal — assert.deepEqual would trip on
    // "same structure but not reference-equal", so fields are compared individually.
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, "set_zoom");
    assert.equal(calls[0].payload.factor, 1.25);
    assert.equal(getRefreshCalls(), 1);
  });

  await t.test("tolerates a tab with no editor yet (view-only tab)", async () => {
    const ctx = freshApp();
    const { app } = ctx;
    stubInvoke(ctx);
    app.state.tabs.push({ editor: null });

    await assert.doesNotReject(() => ctx.window.applyZoom());
  });
});

test("stepZoom", async (t) => {
  await t.test("moves to the next step up or down and persists it", async () => {
    const ctx = freshApp();
    const { window, app } = ctx;
    stubInvoke(ctx);
    window.localStorage.setItem(app.ZOOM_KEY, "1");

    await window.stepZoom(1);
    assert.equal(window.zoomFactor(), 1.1);

    await window.stepZoom(-1);
    assert.equal(window.zoomFactor(), 1);
  });

  await t.test("clamps at the top of the table instead of running off the end", async () => {
    const ctx = freshApp();
    const { window, app } = ctx;
    stubInvoke(ctx);
    const top = app.ZOOM_STEPS[app.ZOOM_STEPS.length - 1];
    window.localStorage.setItem(app.ZOOM_KEY, String(top));

    await window.stepZoom(1);

    assert.equal(window.zoomFactor(), top);
  });

  await t.test("clamps at the bottom of the table instead of running off the end", async () => {
    const ctx = freshApp();
    const { window, app } = ctx;
    stubInvoke(ctx);
    window.localStorage.setItem(app.ZOOM_KEY, String(app.ZOOM_STEPS[0]));

    await window.stepZoom(-1);

    assert.equal(window.zoomFactor(), app.ZOOM_STEPS[0]);
  });
});

test("resetZoom", async (t) => {
  await t.test("persists and applies the default factor regardless of the current level", async () => {
    const ctx = freshApp();
    const { window, app } = ctx;
    const calls = stubInvoke(ctx);
    window.localStorage.setItem(app.ZOOM_KEY, "2.5");

    await window.resetZoom();

    assert.equal(window.zoomFactor(), app.ZOOM_DEFAULT);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, "set_zoom");
    assert.equal(calls[0].payload.factor, app.ZOOM_DEFAULT);
  });
});
