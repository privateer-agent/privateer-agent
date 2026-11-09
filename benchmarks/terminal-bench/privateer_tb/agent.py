"""Harbor adapter that runs the released Privateer CLI inside a benchmark task.

The agent is the official linux-x64 release bundle (PRIVATEER_BUNDLE on the host),
launched the way a user runs it headless: `privateer -p --mode json`. It signs in with
this machine's account login, seeded as files so it never appears in a command line or
in Harbor's logs. Each process mints its own child session from that login and only
validates the parent token, so seeding it cannot sign the host out.

--no-quarter is what makes this unattended, and is only acceptable because the run is
inside a disposable container: without it, anything needing approval is denied.
"""

import json
import os
import shlex
from pathlib import Path
from typing import override

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

REMOTE_ROOT = "/opt/privateer-linux-x64"
REMOTE_HOME = "/opt/privateer-home"
LAUNCHER = f"{REMOTE_ROOT}/bin/privateer-tui"
# account-models.json is the cached model catalog, which any machine that has run Privateer
# once would have. Without it the model is unknown at launch and runs with default limits.
SEEDED_FILES = ("credentials.json", "account-trust.json", "account-models.json")

OUTPUT_FILENAME = "privateer.jsonl"
STDERR_FILENAME = "privateer.stderr.log"
EXIT_FILENAME = "privateer.exit"
UV_INSTALLER_URL = "https://astral.sh/uv/0.9.5/install.sh"


class PrivateerAgent(BaseInstalledAgent):
    @staticmethod
    @override
    def name() -> str:
        return "privateer"

    @override
    def get_version_command(self) -> str | None:
        return f"PRIVATEER_HOME={REMOTE_HOME} {LAUNCHER} --version </dev/null"

    @override
    def parse_version(self, stdout: str) -> str:
        return stdout.strip().splitlines()[-1].strip()

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        bundle = Path(os.environ["PRIVATEER_BUNDLE"])
        login_dir = Path.home() / ".privateer"

        await environment.upload_file(bundle, "/tmp/privateer.tar.gz")
        await self.exec_as_root(
            environment,
            command=(
                "tar -xzf /tmp/privateer.tar.gz -C /opt && "
                f"rm -f /tmp/privateer.tar.gz && mkdir -p {REMOTE_HOME}"
            ),
        )
        for filename in SEEDED_FILES:
            await environment.upload_file(
                login_dir / filename, f"{REMOTE_HOME}/{filename}"
            )
        # The agent user varies by task image and has to write its session state here.
        await self.exec_as_root(environment, command=f"chmod -R a+rwX {REMOTE_HOME}")
        await self.exec_as_agent(
            environment, command=f"{self.get_version_command()}"
        )

    @with_prompt_template
    @override
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        if not self.model_name:
            raise ValueError("A model is required, e.g. privateer/openai/gpt-5.5")

        logs = str(self.environment_logs_dir)
        output = shlex.quote(f"{logs}/{OUTPUT_FILENAME}")
        stderr = shlex.quote(f"{logs}/{STDERR_FILENAME}")
        exit_file = shlex.quote(f"{logs}/{EXIT_FILENAME}")
        level = os.environ.get("TB_THINKING")
        thinking = f"--thinking {shlex.quote(level)} " if level else ""

        # stdin must be closed: `-p` waits for EOF on any open non-TTY stdin, forever.
        # message_update events are per-token deltas, too large to keep on long tasks.
        script = (
            f"mkdir -p {shlex.quote(logs)}; "
            f"PRIVATEER_HOME={REMOTE_HOME} {LAUNCHER} -p --mode json --no-session "
            f"--no-quarter --model {shlex.quote(self.model_name)} {thinking}"
            f"{shlex.quote(instruction)} 2>{stderr} </dev/null "
            "| grep --line-buffered -v '\"type\":\"message_update\"' "
            f"> {output}; "
            # The agent's exit code is recorded, not propagated: a crashed agent should
            # still be scored by the verifier, the same as any other failed attempt.
            f'echo "${{PIPESTATUS[0]}}" > {exit_file}; exit 0'
        )
        await self.exec_as_agent(
            environment, command=f"bash -c {shlex.quote(script)}"
        )
        await self._install_verifier_tools(environment)

    async def _install_verifier_tools(self, environment: BaseEnvironment) -> None:
        """Fetch what the verifier downloads, with retries, once the agent has finished.

        Every verifier installs uv and Python 3.13 from GitHub with no retry, so one bad
        response throws away a finished, paid-for attempt. Already being installed makes
        its own download harmless. It waits until the agent is done so that the agent
        never sees tools the task did not give it.
        """
        script = (
            "command -v curl >/dev/null || "
            "{ apt-get update -qq && apt-get install -y -qq curl; } >/dev/null 2>&1; "
            "for attempt in $(seq 1 12); do "
            f"curl -fsSL {UV_INSTALLER_URL} 2>/dev/null | sh >/dev/null 2>&1 && "
            '. "$HOME/.local/bin/env" && uv python install 3.13 >/dev/null 2>&1 && exit 0; '
            "sleep 10; "
            "done; exit 1"
        )
        try:
            await self.exec_as_root(environment, command=f"bash -c {shlex.quote(script)}")
        except RuntimeError:
            self.logger.warning("Could not pre-install verifier tools; it will try itself.")

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        output = self.logs_dir / OUTPUT_FILENAME
        if not output.exists():
            return

        fresh_input = cache_read = cache_write = output_tokens = 0
        cost = 0.0
        with output.open() as lines:
            for line in lines:
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if event.get("type") != "message_end":
                    continue
                message = event.get("message") or {}
                if message.get("role") != "assistant":
                    continue
                usage = message.get("usage") or {}
                fresh_input += usage.get("input", 0)
                cache_read += usage.get("cacheRead", 0)
                cache_write += usage.get("cacheWrite", 0)
                output_tokens += usage.get("output", 0)
                cost += (usage.get("cost") or {}).get("total", 0.0)

        context.n_input_tokens = fresh_input + cache_read + cache_write
        context.n_cache_tokens = cache_read
        context.n_output_tokens = output_tokens
        context.cost_usd = cost if cost > 0 else None
