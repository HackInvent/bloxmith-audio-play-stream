#!/usr/bin/env python3
"""FB1–FB6: Audio playback, explicit command limitations, both modes and real browser decoding.

Only generated test audio and isolated graphs are used. No microphone or external API is accessed.
"""
from __future__ import annotations

import base64
from dataclasses import replace
from pathlib import Path
import subprocess
import sys
import time
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(ROOT), str(ROOT / "tests")]

from blocs.audio_play_stream.block import AudioPlayStreamBlock, DEFAULTS, _config
from blocs.microphone_stream.block import MicrophoneStreamBlock
from blocs.registry import get_block_definition
from bloxsmith_app.block_api import BlockRuntimeContext
from bloxsmith_app.block_runtime import BlockInputEvent
from bloxsmith_app.graph import WorkflowGraph
from bloxsmith_app.orchestrator import WorkflowOrchestrator
from ui_smoke_common import create_project_api, graph_payload, http_json, project_editor_url, run_playwright_smoke
from block_test_artifacts import artifact_path
from block_test_packages import install_test_package, release_key, surface_payload

BLOCK = AudioPlayStreamBlock()


def context_for(mode="zeromq_active", **values):
    """Build a public context with current ports and optional input events/values for activation tests."""
    services = values.pop("services", {})
    return BlockRuntimeContext(
        run_id="audio-play-test", node_id="player", kind=BLOCK.kind, title=BLOCK.default_title(),
        config=dict(DEFAULTS), runtime_mode=mode,
        input_ports=tuple(SimpleNamespace(**port) for port in BLOCK.model["ports"]["inputs"]),
        output_ports=(), services=services, root_dir=ROOT, **values,
    )


def node(block, node_id):
    """Serialize a real autonomous block for graph and surface tests."""
    return {"id": node_id, "kind": block.kind, "title": block.default_title(),
            "inputs": block.default_inputs(), "outputs": block.default_outputs(),
            "config": block.default_config(), "x": 120, "y": 160}


def test_contract_settings_and_assets():
    """FB1/FB2/FB5: strict ports/settings, honest simulation, complete discoverable assets."""
    assert isinstance(get_block_definition(BLOCK.kind), AudioPlayStreamBlock)
    for mode in ("centralized", "zeromq_active"):
        context = context_for(mode)
        assert BLOCK.prepare_runtime(context).keep_alive == (mode == "zeromq_active")
        result = BLOCK.execute_runtime(context)
        assert result.status == ("skipped" if mode == "centralized" else "success")
        assert not result.outputs and context.services == {}
        invalid = replace(context, input_ports=())
        assert BLOCK.execute_runtime(invalid).status == "failed"
        try:
            BLOCK.prepare_runtime(invalid)
        except ValueError:
            pass
        else:
            raise AssertionError("Invalid ports accepted")
    for config in ({"volume": True}, {"volume": -1}, {"muted": "false"}, {"latency_ms": "nan"},
                   {"max_buffer_sec": 11}, {"volume": ""}, {"latency_ms": None}):
        try:
            _config(config)
        except ValueError:
            pass
        else:
            raise AssertionError(f"Invalid config accepted: {config}")
    current = node(BLOCK, "player")
    result = BLOCK.handle_ui_action(node=current, action="save_properties",
        values={"title": "Mon lecteur", "config": {"volume": "42", "muted": True}})
    assert result["node_patch"]["title"] == "Mon lecteur"
    assert result["node_patch"]["config"]["volume"] == 42
    assert result["node_patch"]["config"]["muted"] is True
    for values in ({"title": " "}, {"config": {"unknown": True}}, {"config": {"muted": 1}}):
        assert "error" in BLOCK.handle_ui_action(node=current, action="save_properties", values=values)
    assert BLOCK.model["browser_runtime"] == {"audio_output": True}
    for surface in ("modal", "inspector_panel", "node_card", "browser_runtime"):
        assets = BLOCK.model["ui_assets"][surface]
        assert assets
        for asset in assets:
            assert (BLOCK.directory / asset["path"]).is_file()
    for render in (BLOCK.render_modal, BLOCK.render_inspector_panel, BLOCK.render_node_card):
        html = render(node={**current, "title": '<script>alert("x")</script>'})["html"]
        assert "<script>" not in html and "data-player-status" in html and "{{" not in html, html
    assert (BLOCK.directory / "README.md").is_file()
    modal = BLOCK.render_modal(node=current, payload={"runtime": {"error": "Échec de lecture test"}})["html"]
    assert 'audio-play-diagnostics" open' in modal and "Échec de lecture test" in modal
    assert modal.count("data-block-modal-error-panel") == 1
    assert 'value="80"' in modal and 'value="80.0"' not in modal
    assert BLOCK.model["runtime"]["active_execution_policy"] == "on_each_event"
    assert len(BLOCK.default_inputs()) == 2
    for render in (BLOCK.render_modal, BLOCK.render_inspector_panel):
        assert "Interruption immédiate" in render(node=current)["html"]
        assert "Recréez-le" in render(node={**current, "inputs": current["inputs"][:1]})["html"]


def test_port_order():
    """FB1/FB2/FB6: reordered inputs preserve commands and strict validation in both modes."""
    for mode in ("centralized", "zeromq_active"):
        base = context_for(mode)
        for ports in (base.input_ports, base.input_ports[::-1]):
            resets = []
            services = {"reset_browser_audio": lambda: resets.append(True) or {"scheduled_readers": 2}} if mode == "zeromq_active" else {}
            ctx = replace(context_for(mode, services=services), input_ports=ports)
            before = [vars(p).copy() for p in ports]
            assert BLOCK.prepare_runtime(ctx).keep_alive == (mode == "zeromq_active")
            ctx.input_attribute("command_in").update('{"action":"interrupt"}')
            result = BLOCK.execute_runtime(ctx)
            assert result.status == ("success" if mode == "zeromq_active" else "skipped") and not result.outputs
            expected = {"action": "interrupt", "applied": mode == "zeromq_active"}
            if mode == "zeromq_active":
                expected["scheduled_readers"] = 2
                assert resets == [True]
            else:
                expected["reason"] = "simulation"
                assert not resets
            assert result.metadata[BLOCK.kind]["command"] == expected
            assert [vars(p) for p in ctx.input_ports] == before
        legacy = replace(context_for(mode), input_ports=base.input_ports[:1])
        assert BLOCK.prepare_runtime(legacy).keep_alive == (mode == "zeromq_active")
        assert BLOCK.execute_runtime(legacy).status == ("success" if mode == "zeromq_active" else "skipped")
        assert len(legacy.input_ports) == 1
        invalid_ports = [(), (base.input_ports[1],), (base.input_ports[0], base.input_ports[0]),
                         (*base.input_ports, base.input_ports[0])]
        for index, port in enumerate(base.input_ports):
            for change in ({"id": 99}, {"name": "wrong"}, {"required": True}, {"multiplicity": "many"},
                           {"transport": "message" if index == 0 else "audio_stream"}):
                changed = list(base.input_ports)
                changed[index] = SimpleNamespace(**{**vars(port), **change})
                invalid_ports.append(tuple(reversed(changed)))
        for ports in invalid_ports:
            ctx = replace(context_for(mode), input_ports=ports)
            try:
                BLOCK.prepare_runtime(ctx)
            except ValueError:
                pass
            else:
                raise AssertionError(f"Invalid ports accepted: {ports}")
            assert BLOCK.execute_runtime(ctx).status == "failed"


def test_explicit_commands():
    """FB1/FB2/FB6: apply fresh interruptions once; reject replay, malformed data and missing bridges."""
    event = BlockInputEvent(edge_id="commands", input_port_id=2, input_port_name="command_in",
        source_node_id="control", source_port_id=1, value='{"action":"interrupt"}',
        content_type="application/json", sequence=1)
    for mode in ("centralized", "zeromq_active"):
        for values in ({"input_events": (event,)}, {"inputs": {"command_in": event.value}}):
            resets = []
            services = {"reset_browser_audio": lambda: resets.append(True) or {"scheduled_readers": 3}} if mode == "zeromq_active" else {}
            context = context_for(mode, services=services, **values)
            result = BLOCK.execute_runtime(context)
            assert result.status == ("success" if mode == "zeromq_active" else "skipped")
            assert not result.outputs
            expected = {"action": "interrupt", "applied": mode == "zeromq_active"}
            if mode == "zeromq_active":
                expected["scheduled_readers"] = 3
                assert resets == [True]
            else:
                expected["reason"] = "simulation"
                assert not resets
            assert result.metadata[BLOCK.kind]["command"] == expected
        stale = context_for(mode, inputs={"command_in": event.value})
        stale.mark_inputs_consumed()
        assert "command" not in BLOCK.execute_runtime(stale).metadata[BLOCK.kind]
        other_event = replace(event, input_port_id=1, input_port_name="audio_in")
        irrelevant = context_for(mode, inputs={"command_in": event.value}, input_events=(other_event,))
        assert "command" not in BLOCK.execute_runtime(irrelevant).metadata[BLOCK.kind]
        legacy = replace(context_for(mode), input_ports=context_for(mode).input_ports[:1], input_events=(event,))
        assert "command" not in BLOCK.execute_runtime(legacy).metadata[BLOCK.kind]
        assert len(legacy.input_ports) == 1, "Runtime must not migrate persisted topology."
        for raw in ('', 'null', '[]', '{', '{"action":"stop"}', '{"action":"start"}',
                    '{"action":"interrupt","extra":1}', ' ' * 4097, None):
            invalid = context_for(mode, input_events=(replace(event, value=raw),))
            result = BLOCK.execute_runtime(invalid)
            assert result.status == "failed" and not result.outputs, (raw, result)
        for change in ({"required": True}, {"multiplicity": "many"}, {"accepts": ["text/plain"]},
                       {"execution_requirement": "required_for_execution"}):
            ports = context_for(mode).input_ports
            altered = SimpleNamespace(**{**vars(ports[1]), **change})
            assert BLOCK.execute_runtime(replace(context_for(mode), input_ports=(ports[0], altered))).status == "failed"

    missing = context_for("zeromq_active", input_events=(event,))
    assert BLOCK.execute_runtime(missing).metadata[BLOCK.kind]["command"]["reason"] == "reset_browser_audio_unavailable"
    malformed = context_for("zeromq_active", input_events=(event,), services={"reset_browser_audio": lambda: {"scheduled_readers": True}})
    assert BLOCK.execute_runtime(malformed).metadata[BLOCK.kind]["command"]["reason"] == "reset_browser_audio_failed"
    raised = context_for("zeromq_active", input_events=(event,), services={"reset_browser_audio": lambda: (_ for _ in ()).throw(RuntimeError("reset refused"))})
    assert BLOCK.execute_runtime(raised).metadata[BLOCK.kind]["command"]["reason"] == "reset_browser_audio_failed"


def test_command_graph_modes():
    """FB2/FB6: real command routing respects reversed Player ports without audio or playback claims."""
    source = node(get_block_definition("text"), "source")
    source["outputs"][0]["text"] = "Déclencher"
    control = node(get_block_definition("python"), "control")
    control["config"]["script"] = 'def run(inputs, outputs, params):\n    outputs["out"] = {"action": "interrupt"}\n'
    control["outputs"][0]["emits"] = ["application/json"]
    player = node(BLOCK, "player")
    player["inputs"].reverse()
    graph = WorkflowGraph.from_payload({"nodes": [source, control, player], "edges": [
        {"id": "trigger", "fromNodeId": "source", "fromPortId": 1, "toNodeId": "control", "toPortId": 1},
        {"id": "commands", "fromNodeId": "control", "fromPortId": 1, "toNodeId": "player", "toPortId": 2}]})
    with TemporaryDirectory(prefix="audio-player-commands-") as directory:
        root = Path(directory)
        engine = WorkflowOrchestrator(root_dir=root, runs_dir=root / "runs", active_worker_host="thread")
        active = engine.prepare_active_run(graph)
        assert active.status == "prepared", active.logs
        try:
            engine.play_active_run(active.run_id)
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline and not active.results.get("player", {}).get(BLOCK.kind, {}).get("command"):
                time.sleep(.02)
            command = active.results.get("player", {}).get(BLOCK.kind, {}).get("command")
            assert command == {"action": "interrupt", "applied": True,
                               "scheduled_readers": 0}, (active.results, active.logs)
            # The node-scoped reset is successful even when no browser reader is currently attached.
            assert active.node_statuses["player"] not in {"failed", "cancelled"}, dict(active.node_statuses)
            assert active.output_values.get("player", {}) == {}
        finally:
            engine.stop_active_run(active.run_id)
        simulation = engine.create_run(graph, runtime_mode="centralized", auto_start=False)
        engine._execute_run(simulation)
        assert simulation.status == "success", simulation.logs
        assert simulation.results["player"][BLOCK.kind]["command"] == {
            "action": "interrupt", "applied": False, "reason": "simulation"}


def test_real_graph_modes():
    """FB1/FB2: actual Microphone→Player wiring and browser egress without fake block kinds."""
    graph = WorkflowGraph.from_payload({"nodes": [node(MicrophoneStreamBlock(), "micro"), node(BLOCK, "player")],
        "edges": [{"id": "audio", "fromNodeId": "micro", "fromPortId": 1, "toNodeId": "player", "toPortId": 1}]})
    with TemporaryDirectory(prefix="audio-play-graph-") as directory:
        root = Path(directory)
        engine = WorkflowOrchestrator(root_dir=root, runs_dir=root / "runs", active_worker_host="thread")
        run = engine.prepare_active_run(graph)
        assert run.status == "prepared", run.logs
        try:
            manager = engine.runtime_audio_egress(run.run_id)
            ticket = manager.create_session(node_id="player", input_port="audio_in")
            reader = manager.attach(ticket.session_id, ticket.ticket)
            session = engine._active_sessions[run.run_id]
            source = session.controller.runtime_audio_stream_service.client_for("micro",
                port_routes=run.plan.worker_configs["micro"].runtime_audio_stream_port_routes)
            source.publish_port("audio_out", b"opus-test", codec="opus", sample_rate_hz=48000, channels=1,
                                stream_id="test-stream")
            assert reader.receive_frame(.5).payload == b"opus-test"
        finally:
            engine.stop_active_run(run.run_id)
        assert not reader.available
        simulation = engine.create_run(graph, runtime_mode="centralized", auto_start=False)
        engine._execute_run(simulation)
        assert simulation.status == "success", simulation.logs


def fixtures(*, include_speech=False):
    """Generate one-second mono/stereo Opus containers and optional local speech, never user recordings."""
    result = {}
    for container in ("ogg", "webm"):
        for channels in (1, 2):
            command = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
                       "sine=frequency=440:sample_rate=48000", "-t", "1", "-ac", str(channels),
                       "-c:a", "libopus", "-b:a", "64000", "-f", container]
            command += ["-page_duration", "100000"] if container == "ogg" else ["-cluster_time_limit", "100"]
            data = subprocess.run([*command, "pipe:1"], capture_output=True, check=True, timeout=10).stdout
            result[f"{container}_{channels}"] = base64.b64encode(data).decode("ascii")
    if include_speech:
        # Speech exercises predictive Opus state as well as the CELT tone fixtures.
        command = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
                   "flite=text=Please keep the voice clear and continuous:voice=slt", "-t", "1",
                   "-ar", "48000", "-ac", "1", "-c:a", "libopus", "-application", "voip",
                   "-b:a", "24000", "-f", "ogg", "-page_duration", "100000", "pipe:1"]
        data = subprocess.run(command, capture_output=True, check=True, timeout=10).stdout
        result["ogg_1_speech"] = base64.b64encode(data).decode("ascii")
    return result


def reference_pcm(encoded_fixtures):
    """Decode complete containers with reference libopus through FFmpeg for waveform comparisons.

    FFmpeg's separate native Opus decoder differs numerically on SILK speech;
    explicitly select libopus so that this test isolates lost inter-packet state.
    """
    references = {}
    for name, encoded in encoded_fixtures.items():
        data = subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-c:a", "libopus", "-i", "pipe:0", "-ar", "48000",
             "-c:a", "pcm_f32le", "-f", "f32le", "pipe:1"],
            input=base64.b64decode(encoded), capture_output=True, check=True, timeout=10,
        ).stdout
        references[name] = base64.b64encode(data).decode("ascii")
    return references


def test_browser(page, server, blocking_errors):
    """FB3/FB4/FB5/FB6: real managed modules, decoding, playback reset and Web Audio scheduling."""
    model = install_test_package(server, "audio_play_stream")
    key = quote(release_key(model), safe="")
    asset_base = f"{server.base_url}/api/blocks/{key}/assets"
    current = node(BLOCK, "player")
    current["block_version"] = model["version"]
    surfaces = {surface: surface_payload(server, model, current, surface)
                for surface in ("modal", "inspector_panel", "node_card")}
    catalog = next(item for item in http_json(server.base_url, "/api/blocks")["blocks"]
                   if item["kind"] == release_key(model))
    browser_assets = catalog["browser_runtime_assets"]
    asset_url = lambda assets, suffix: f"{asset_base}/" + next(
        item["path"] for item in assets if item["path"].endswith(suffix))
    modules = {
        "common": asset_url(browser_assets, "/assets/js/common.js"),
        "browserRuntime": asset_url(browser_assets, "/assets/js/browser_runtime.js"),
        "modal": asset_url(surfaces["modal"]["assets"], "/assets/js/block_modal.js"),
    }
    page.goto(server.base_url)
    page.set_content('<button id="activate">Audio</button><div id="surface"></div>')
    page.evaluate("""() => {
      document.querySelector('#activate').onclick = async () => {
        window.testAudio = new AudioContext({ sampleRate: 48000 });
        await window.testAudio.resume();
      };
    }""")
    page.click("#activate")
    page.wait_for_function("window.testAudio?.state === 'running'")
    media = fixtures(include_speech=True)
    result = page.evaluate((BLOCK.directory / "tests/browser_test.js").read_text(), {
        "fixtures": media, "references": reference_pcm(media),
        "modal": BLOCK.render_modal(node=current)["html"], "modules": modules,
    })
    assert result["passed"], result
    print(f"[ok] Opus waveform fidelity vs FFmpeg: {result['fidelity']}", flush=True)
    print("[ok] Native browser PCM/Opus/MediaRecorder, controls and cleanup", flush=True)
    test_editor_path(page, server, model, modules)


def test_editor_path(page, server, model, modules):
    """FB1–FB6: real editor Run → audio edge → managed browser playback and Stop."""
    nodes = [MicrophoneStreamBlock().build_node_payload(node_id="micro"), BLOCK.build_node_payload(node_id="player")]
    nodes[1]["block_version"] = model["version"]
    nodes[0]["position"] = {"x": 150, "y": 180}
    nodes[1]["position"] = {"x": 530, "y": 180}
    document = graph_payload("Audio playback integration", nodes, [
        {"id": "audio", "from": {"node": "micro", "port": 1}, "to": {"node": "player", "port": 1}, "kind": "data"}])
    workspace_project = create_project_api(server, title="Audio playback integration", document=document)["project"]
    graph_id = workspace_project.get("graph_id") or workspace_project["project_id"]
    workspace_project_id = workspace_project["workspace_project_id"]
    page.goto(project_editor_url(server.base_url, graph_id, workspace_project_id=workspace_project_id))
    page.wait_for_selector('.canvas-node[data-node-id="player"]')
    page.click("#activeRuntimeModeButton")
    with page.expect_response(lambda response: response.url.endswith("/runs/prepare") and response.request.method == "POST") as response:
        page.click("#loadRunButton")
    run = response.value.json()
    assert response.value.ok and run.get("run_id"), run
    scope = {"workspaceProjectId": workspace_project_id, "graphId": graph_id, "instanceId": "1",
             "runId": run["run_id"], "nodeId": "player"}
    if page.locator("#browserAudioUnlockButton").is_visible():
        page.click("#browserAudioUnlockButton")
    module_scope = {"url": modules["common"], "scope": scope}
    page.wait_for_function(
        "async data => { const ui = await import(data.url); return ui.get(ui.key(data.scope))?.player?.snapshot().active; }",
        arg=module_scope,
    )
    # No modal was opened: the framework host alone must have attached the player.
    assert page.locator('.canvas-node[data-node-id="player"] [data-player-mute]').is_enabled()
    page.evaluate("""async ({scope, encoded}) => {
      const source = await window.CWRuntimeAudioStreams.openOutput({ ...scope, nodeId: 'micro',
        outputPort: 'audio_out', codec: 'opus', sampleRateHz: 48000, channels: 1 });
      const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
      for (let offset = 0; offset < bytes.length; offset += 1000) {
        if (!source.sendFrame(bytes.subarray(offset, offset + 1000))) throw new Error('Test transport saturated');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      source.close();
    }""", {"scope": scope, "encoded": fixtures()["webm_1"]})
    page.wait_for_function(
        "async data => { const ui = await import(data.url); return ui.get(ui.key(data.scope))?.player?.snapshot().playedSamples === 48000; }",
        arg=module_scope,
    )
    card_mute = page.locator('.canvas-node[data-node-id="player"] [data-player-mute]')
    card_mute.click()
    assert page.evaluate(
        "async data => { const ui = await import(data.url); return ui.get(ui.key(data.scope)).player.snapshot().muted; }",
        module_scope,
    )
    page.click("#stopRunButton")
    page.wait_for_function(
        "async data => { const ui = await import(data.url); return !ui.get(ui.key(data.scope))?.player; }",
        arg=module_scope,
    )
    assert card_mute.is_disabled()
    print("[ok] Real editor/browser ingress/graph edge/browser egress/Stop", flush=True)
    test_modal_layout(page)


def test_modal_layout(page):
    """FB5/FB6: real responsive shell keeps command limitation readable and actions reachable."""
    page.locator('.canvas-node[data-node-id="player"] h3').dblclick()
    modal = page.locator('[data-generic-block-modal-root][data-node-kind="audio_play_stream"]')
    modal.wait_for()
    for width, height, label in ((1440, 900, "desktop"), (390, 740, "mobile"), (320, 568, "small")):
        page.set_viewport_size({"width": width, "height": height})
        bounds = modal.evaluate("""panel => {
          const rect = panel.getBoundingClientRect();
          const body = panel.querySelector('.audio-play-body');
          const apply = panel.querySelector('[data-player-apply]').getBoundingClientRect();
          const close = panel.querySelector('[data-close-block-modal]').getBoundingClientRect();
          const check = panel.querySelector('[data-player-setting="muted"]').getBoundingClientRect();
          return {background: getComputedStyle(panel).backgroundColor, left: rect.left, right: rect.right,
            top: rect.top, bottom: rect.bottom, overflow: body.scrollWidth > body.clientWidth + 1,
            applyVisible: apply.bottom <= innerHeight && apply.top >= 0,
            closeVisible: close.bottom <= innerHeight && close.top >= 0, checkbox: check.width};
        }""")
        assert bounds["background"] == "rgb(255, 255, 255)", bounds
        assert bounds["left"] >= 0 and bounds["right"] <= width and bounds["bottom"] <= height, bounds
        assert not bounds["overflow"] and bounds["applyVisible"] and bounds["closeVisible"], bounds
        assert 16 <= bounds["checkbox"] <= 22, bounds
        assert modal.locator("[data-block-modal-error-panel]").count() == 1
        assert not modal.locator(".audio-play-advanced").evaluate("element => element.open")
        notice = modal.locator("[data-player-command-notice]")
        notice.scroll_into_view_if_needed()
        assert notice.is_visible() and "arrête immédiatement" in notice.inner_text()
        assert not notice.evaluate("element => element.scrollWidth > element.clientWidth + 1")
        page.screenshot(path=artifact_path(f"audio-play-modal-{label}.png"))
    advanced = modal.locator(".audio-play-advanced summary")
    advanced.focus()
    page.keyboard.press("Enter")
    assert modal.locator(".audio-play-advanced").evaluate("element => element.open")
    # A hidden invalid advanced setting must be revealed before browser validation focuses it.
    latency = modal.locator('[data-player-setting="latency_ms"]')
    latency.fill("0")
    advanced.click()
    modal.locator('[data-player-apply]').click()
    assert modal.locator(".audio-play-advanced").evaluate("element => element.open")
    assert "Vérifiez" in modal.locator('[data-player-feedback]').inner_text()
    latency.fill("100")
    modal.locator('[data-close-block-modal]').click()
    page.set_viewport_size({"width": 1440, "height": 900})
    page.evaluate("openInspectorPanel()")
    # The native rail is intentionally a 72px peek until hover/focus; use its actual expand/pin controls.
    page.locator('.right-rail').hover(position={"x": 20, "y": 100})
    page.locator('#pinInspectorButton').click()
    inspector = page.locator('#blockOwnedInspectorView [data-block-inspector-root][data-node-id="player"]')
    inspector.wait_for(state="visible")
    notice = inspector.locator('[data-player-command-notice]')
    notice.scroll_into_view_if_needed()
    assert notice.is_visible() and "arrête immédiatement" in notice.inner_text()
    assert not notice.evaluate("element => element.scrollWidth > element.clientWidth + 1")
    assert notice.evaluate("element => element.getBoundingClientRect().right <= innerWidth")
    page.screenshot(path=artifact_path("audio-play-inspector-command.png"))
    print("[ok] Real modal UX: desktop/mobile, contrast, keyboard and validation", flush=True)


if __name__ == "__main__":
    test_contract_settings_and_assets()
    test_port_order()
    print("[ok] Audio Play contracts/settings/assets", flush=True)
    test_explicit_commands()
    test_command_graph_modes()
    print("[ok] Audio Play explicit commands / real graph / both modes", flush=True)
    test_real_graph_modes()
    print("[ok] Audio Play real graph / both modes", flush=True)
    run_playwright_smoke("F5.47_audio_play_stream", test_browser)
