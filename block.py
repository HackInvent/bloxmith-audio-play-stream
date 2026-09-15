"""Declare graph ports and settings; browser-owned assets decode and play audio."""

from __future__ import annotations

from collections.abc import Mapping
from html import escape
import json
import math
from typing import Any

from bloxsmith_app.block_api import (
    BlockDefinition, BlockRuntimeContext, BlockRuntimePreparation,
    BlockRuntimePreparationContext, BlockRuntimeResult,
    render_inspector_template, render_node_card_template,
)

DEFAULTS = {"volume": 80, "muted": False, "latency_ms": 100, "max_buffer_sec": 5}
BOUNDS = {"volume": (0, 100), "latency_ms": (20, 1000), "max_buffer_sec": (1, 10)}
_NO_COMMAND = object()


def _fresh_command(context: BlockRuntimeContext) -> Any:
    """Read a current command event, or a newly updated attribute when no event is supplied.

    Saved/consumed values and other input activations never replay a previous interruption.
    Legacy audio-only nodes have no command port and keep their original behavior.
    """
    if not any(port.id == 2 and port.name == "command_in" for port in context.input_ports):
        return _NO_COMMAND
    if context.input_events:
        events = [event for event in context.input_events
                  if event.input_port_id == 2 and event.input_port_name == "command_in"]
        return events[-1].value if events else _NO_COMMAND
    attribute = context.input_attribute("command_in")
    return attribute.value if attribute is not None and attribute.status == "updated" else _NO_COMMAND


def _command(raw: Any) -> dict[str, str]:
    """Validate bounded interrupt-only JSON without accepting audio lifecycle stops."""
    if isinstance(raw, str):
        if len(raw.encode("utf-8")) > 4096:
            raise ValueError("Commande trop volumineuse : 4 Kio maximum.")
        try:
            raw = json.loads(raw)
        except (ValueError, RecursionError):
            raise ValueError('command_in attend exactement {"action":"interrupt"}.') from None
    if not isinstance(raw, Mapping) or set(raw) != {"action"} or raw["action"] != "interrupt":
        raise ValueError('command_in attend exactement {"action":"interrupt"} ; start/stop ne sont pas des interruptions.')
    return {"action": "interrupt"}


def _config(raw: Mapping[str, Any] | None) -> dict[str, Any]:
    """Validate durable initial settings; live browser controls do not mutate them."""
    if raw is not None and not isinstance(raw, Mapping):
        raise ValueError("Configuration audio invalide.")
    result = {**DEFAULTS, **(raw or {})}
    for key, (minimum, maximum) in BOUNDS.items():
        try:
            value = float(result[key])
        except (ValueError, TypeError) as exc:
            raise ValueError(f"{key} doit être un nombre.") from exc
        if isinstance(result[key], bool) or not math.isfinite(value) or not minimum <= value <= maximum:
            raise ValueError(f"{key} doit être compris entre {minimum} et {maximum}.")
        result[key] = value
    if not isinstance(result["muted"], bool):
        raise ValueError("Le réglage silence doit être un booléen.")
    return {key: result[key] for key in DEFAULTS}


# FB1 - One fixed audio input and a separate optional data input; preserve legacy audio-only nodes.
# FB2 - Keep browser playback available in Active Runtime; simulation skips all audio IO.
# FB3 - Decode PCM16 and containerized Opus incrementally with bounded local scheduling.
# FB4 - Local volume/mute, explicit errors and complete cleanup on runtime cancellation.
# FB5 - Own all UI surfaces, validated settings, discovery and end-user documentation.
# FB6 - Validate fresh interrupt commands and request a node-scoped browser playback reset.
class AudioPlayStreamBlock(BlockDefinition):
    """Play graph audio independently in each browser through the public egress facade."""

    kind = "audio_play_stream"

    def _validate_ports(self, context: BlockRuntimePreparationContext | BlockRuntimeContext) -> None:
        """Validate context ports by stable id, preserving visual order and audio-only nodes.

        Indexing must not hide duplicate ids or relax the audio/message contract.
        No port, link or persisted setting is rewritten during validation.
        """
        ports = {port.id: port for port in context.input_ports}
        if (len(ports) != len(context.input_ports) or set(ports) not in ({1}, {1, 2})
                or context.output_ports):
            raise ValueError("Audio Play Stream nécessite audio_in, éventuellement command_in, et aucune sortie.")
        audio = ports[1]
        if (audio.name != "audio_in" or audio.transport != "audio_stream"
                or audio.multiplicity != "one" or audio.required):
            raise ValueError("Audio Play Stream nécessite audio_in, éventuellement command_in, et aucune sortie.")
        if len(ports) == 2:
            command = ports[2]
            if (command.name != "command_in"
                    or getattr(command, "transport", "message") != "message"
                    or command.multiplicity != "one" or command.required
                    or getattr(command, "execution_requirement", "not_required_for_execution") != "not_required_for_execution"
                    or tuple(command.accepts) != ("application/json",)):
                raise ValueError("command_in doit rester une entrée JSON facultative à multiplicité un.")

    def prepare_runtime(self, context: BlockRuntimePreparationContext) -> BlockRuntimePreparation:
        """Validate without IO; keep the active worker alive for the browser host."""
        self._validate_ports(context)
        _config(context.config)
        return BlockRuntimePreparation(keep_alive=context.runtime_mode == "zeromq_active")

    def execute_runtime(self, context: BlockRuntimeContext) -> BlockRuntimeResult:
        """Validate fresh commands and request browser playback reset through the public service."""
        try:
            self._validate_ports(context)
            _config(context.config)
            raw = _fresh_command(context)
            command = _command(raw) if raw is not _NO_COMMAND else None
        except (ValueError, TypeError) as exc:
            return BlockRuntimeResult(status="failed", outputs=[], last_message=str(exc), logs=[str(exc)])
        active = context.runtime_mode == "zeromq_active"
        if command is not None:
            if not active:
                message = "Simulation : commande interrupt validée, aucune interruption ni lecture audio."
                return BlockRuntimeResult(status="skipped", outputs=[], last_message=message,
                    logs=[f"[audio-play-stream] {message}"], metadata={self.kind: {
                        "state": "simulation", "command": {**command, "applied": False, "reason": "simulation"}}})
            reset = context.services.get("reset_browser_audio")
            if not callable(reset):
                message = "La passerelle reset_browser_audio requise par Audio Play Stream est indisponible."
                return BlockRuntimeResult(status="failed", outputs=[], last_message=message,
                    error=message, exit_code=1, logs=[f"[audio-play-stream-error] {message}"],
                    metadata={self.kind: {"state": "reset_unavailable",
                        "command": {**command, "applied": False, "reason": "reset_browser_audio_unavailable"}}})
            try:
                reset_result = reset()
                if not isinstance(reset_result, Mapping):
                    raise RuntimeError("Réponse de reset_browser_audio invalide.")
                scheduled = reset_result.get("scheduled_readers")
                if isinstance(scheduled, bool) or not isinstance(scheduled, int) or scheduled < 0:
                    raise RuntimeError("Nombre de lecteurs planifiés invalide.")
            except (RuntimeError, TypeError, ValueError) as exc:
                message = f"Interruption audio impossible : {exc}"
                return BlockRuntimeResult(status="failed", outputs=[], last_message=message,
                    error=message, exit_code=1, logs=[f"[audio-play-stream-error] {message}"],
                    metadata={self.kind: {"state": "reset_failed",
                        "command": {**command, "applied": False, "reason": "reset_browser_audio_failed"}}})
            message = (f"Interruption audio transmise à {scheduled} lecteur"
                       f"{'s' if scheduled != 1 else ''} navigateur.")
            return BlockRuntimeResult(status="success", outputs=[], last_message=message,
                logs=[f"[audio-play-stream] {message}"], metadata={self.kind: {
                    "state": "reset_scheduled", "command": {**command, "applied": True,
                        "scheduled_readers": scheduled}}})
        message = ("Lecteur prêt dans le navigateur : activez le son puis envoyez un flux."
                   if active else "Simulation : aucune lecture audio dans le navigateur.")
        return BlockRuntimeResult(
            status="success" if active else "skipped", outputs=[], last_message=message,
            logs=[f"[audio-play-stream] {message}"],
            metadata={self.kind: {"state": "browser_owned" if active else "simulation"}},
        )

    def render_node_card(self, *, node: dict, payload: dict | None = None) -> dict:
        """Render a local state indicator without creating a second audio receiver."""
        return render_node_card_template(block=self, node=node, node_classes=["audio-play-node"],
                                        replacements={"title": str(node.get("title") or self.default_title())})

    def _settings_html(self, node: dict) -> str:
        """Separate initial controls from advanced timing settings, with compact numeric labels."""
        config = _config(node.get("config"))
        labels = {"volume": "Volume initial (%)", "latency_ms": "Marge de lecture (ms)",
                  "max_buffer_sec": "File audio maximale (s)"}
        fields = {key: f'<label>{label}<input type="number" data-player-setting="{key}" '
                  f'value="{escape(format(config[key], "g"), quote=True)}" min="{BOUNDS[key][0]}" '
                  f'max="{BOUNDS[key][1]}" step="any" required /></label>' for key, label in labels.items()}
        checked = " checked" if config["muted"] else ""
        toggle = ('<label class="audio-play-check"><input type="checkbox" '
                  f'data-player-setting="muted"{checked} /><span>Démarrer en silence</span></label>')
        return (f'<div class="audio-play-fields">{fields["volume"]}{toggle}</div>'
                '<details class="audio-play-disclosure audio-play-advanced"><summary>Réglages audio avancés</summary>'
                '<div class="audio-play-disclosure-body"><p class="audio-play-help">Les valeurs par défaut conviennent pour commencer.</p>'
                f'<div class="audio-play-fields">{fields["latency_ms"]}{fields["max_buffer_sec"]}</div></div></details>')

    def _command_notice_html(self, node: dict) -> str:
        """Explain browser interruption separately from local mute and durable settings."""
        available = any(port.get("id") == 2 and port.get("name") == "command_in" for port in node.get("inputs", []))
        detail = ('<code>command_in</code> reconnaît <code>{"action":"interrupt"}</code>. En Runtime actif, '
                  'la commande arrête immédiatement les sons programmés et vide les buffers de ce lecteur dans chaque navigateur connecté.'
                  if available else 'Ce bloc possède uniquement audio_in. Recréez-le pour ajouter command_in. '
                  'Les blocs existants à une entrée continuent de lire normalement, sans commande d’interruption.')
        return ('<aside class="audio-play-command-note" data-player-command-notice role="note">'
                '<strong>Interruption immédiate</strong><p>' + detail + '</p></aside>')

    def render_modal(self, *, node: dict, payload: dict | None = None) -> dict:
        """Render an opaque panel with fixed actions, diagnostics and interruption guidance."""
        template = (self.directory / "block_modal.html").read_text(encoding="utf-8")
        template = template.replace("{{ settings_html }}", self._settings_html(node))
        template = template.replace("{{ command_notice_html }}", self._command_notice_html(node))
        has_error = bool(self._runtime_error_text(payload or {}))
        template = template.replace('<summary>Diagnostic</summary>',
                                    f'<summary>Diagnostic · {"Erreur" if has_error else "Aucune erreur"}</summary>')
        if has_error:
            template = template.replace('class="audio-play-disclosure audio-play-diagnostics"',
                                        'class="audio-play-disclosure audio-play-diagnostics" open')
        return {"html": self._render_generic_modal_template(template=template, node=node, payload=payload or {}),
                "context": {"node_id": str(node.get("id") or ""), "node_kind": self.kind}}

    def render_inspector_panel(self, *, node: dict, payload: dict | None = None) -> dict:
        """Expose local controls, durable settings and browser interruption in the inspector."""
        template = (self.directory / "inspector_panel.html").read_text(encoding="utf-8")
        html = render_inspector_template(template=template, node={**node, "type": self.kind, "kind": self.kind},
                                         payload=payload, replacements={"settings_html": self._settings_html(node),
                                            "command_notice_html": self._command_notice_html(node)},
                                         show_duplicate=True)
        return {"html": html, "context": {"node_id": str(node.get("id") or ""), "full_panel": True}}

    def handle_ui_action(self, *, node: dict, action: str, values: dict, payload: dict | None = None) -> dict:
        """Save validated title/settings atomically; reject unknown config fields."""
        if action == "save_properties":
            try:
                config = values.get("config", {})
                if not isinstance(config, dict) or set(config) - set(DEFAULTS):
                    raise ValueError("Réglages audio inconnus.")
                title = values.get("title", node.get("title") or self.default_title())
                if not isinstance(title, str) or not title.strip() or len(title) > 200:
                    raise ValueError("Le nom doit contenir de 1 à 200 caractères.")
                normalized = _config({**(node.get("config") or {}), **config})
                return {"node_patch": {"title": title.strip(), "config": normalized}, "rerender_inspector": False}
            except (ValueError, TypeError) as exc:
                return {"error": str(exc)}
        result = super().handle_ui_action(node=node, action=action, values=values, payload=payload)
        patch = result.get("node_patch", {}).get("config")
        if isinstance(patch, dict):
            try:
                normalized = _config({**(node.get("config") or {}), **patch})
                result["node_patch"]["config"] = {key: normalized[key] for key in patch if key in DEFAULTS}
            except (ValueError, TypeError) as exc:
                return {"error": str(exc)}
        return result
