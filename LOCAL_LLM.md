# Configure OpenCode providers for Worklog (with Ollama + Foundry examples)

Any OpenCode-supported provider can be used with Worklog.

This document uses two concrete examples so the steps are easy to follow. There's good reason for me choosing these models:

**Ollama** - I run this on a dedicated Mini-PC with 128Gb of shared RAM and a beefy CPU. This thing can run pretty big models suitable for coding locally and cheaply. This provides a network reachable endpoint.

**Microsoft Foundry Local** - This is used on my portable device which as an NPU. I use this for management tasks like orchestration, work-item management, and planning where I need to be much more hands on with the model. Since this device is portable it means I can manage my AI agents from wherever I am.

This includes:

- The **TUI OpenCode dialog** today (press `O` in `wl tui`)
- Future **LLM-powered CLI commands** (e.g., issue/work-item management helpers)

The goal is to make it easy for agents to leverage **local compute** for tasks that don’t require a massive cloud-hosted model running on a huge GPU, while still allowing optional cloud providers when they’re genuinely needed.

---

## How the pieces fit together

Worklog does **not** call any model provider directly.

1. Worklog starts (or connects to) an LLM provider. By default it does this through an **OpenCode server** (`opencode serve`)
2. OpenCode server talks to a **model provider** (Ollama locally, Foundry Local, cloud providers, or any other provider you configure)

See [docs/opencode-tui.md](docs/opencode-tui.md) for the current TUI integration details.

---

## Prerequisites

- Worklog installed/running locally (see [Readme](README.md))
- OpenCode installed and on `PATH` (see [https://opencode.ai](https://opencode.ai))
- At least one of the following installed:
  - Ollama [https://github.com/ollama/ollama]
  - Microsoft Foundry Local [https://github.com/microsoft/Foundry-Local]

---

## Microsoft Foundry Local

Microsoft Foundry Local is an on-device AI inference solution that you use to run AI models locally through a CLI, SDK, or REST API.

### Install and configure Microsoft Foundry Local

In this example we will use the excellent Phi4 model, but you can choose any model supported by Foundry Local (`foundry model list`).

1. [Install Foundry Local](https://learn.microsoft.com/en-us/azure/ai-foundry/foundry-local/get-started)

2. Dowload and run the Phi4 model:

Start the Foundry Local service:

```powershell
$FOUNDRY_PORT = 65000 # you can pick any free port
foundry service set --port $FOUNDRY_PORT
foundry service start
```

Download the chosen model:

```powershell
$FOUNDRY_MODEL_NAME = "phi-4-openvino-gpu:1" # be sure to select the right variant for your hardware
foundry model download $FOUNDRY_MODEL_NAME
```

Run the model on the service:

```powershell
foundry model load $FOUNDRY_MODEL_NAME # replace load with run if you want to drop straight into a chat
```

Verify the model is running by sending a test request:

```powershell
$payload = @{
  model    = $FOUNDRY_MODEL_NAME
  messages = @(
    @{ role = "user"; content = "Hello World!" }
  )
} | ConvertTo-Json -Depth 10

$resp = Invoke-RestMethod -Method Post `
  -Uri "http://localhost:$FOUNDRY_PORT/v1/chat/completions" `
  -ContentType "application/json" `
  -Body $payload

$resp.choices[0].message.content
```

### Configure OpenCode to use Foundry Local

NOTE: if you use WSL to run Worklog and Opencode you will probably need to perform some one-time networking setup to allow WSL to reach your Foundry Local endpoint running on Windows. See the Appendix at the end of this document for details.

Configure OpenCode to call your Foundry Local endpoint.

```bash
export WIN_HOST_IP=$(ip route show default | awk '{print $3}')
export FOUNDRY_PORT=65000  # or your chosen port
export FOUNDRY_MODEL_NAME="phi-4-openvino-gpu:1" # be sure to select the right variant for

CONFIG_DIR="${HOME}/.config/opencode"
CONFIG_FILE="${CONFIG_DIR}/opencode.json"

mkdir -p "$CONFIG_DIR"

# Ensure file exists and is valid JSON
if [ ! -s "$CONFIG_FILE" ]; then
    echo '{}' > "$CONFIG_FILE"
fi

# Build provider JSON safely
PROVIDER_JSON=$(cat <<EOF
{
  "provider": {
    "foundry-local": {
      "name": "Foundry Local",
      "npm": "@ai-sdk/openai-compatible",
      "options": {
          "baseURL": "http://${WIN_HOST_IP}:${FOUNDRY_PORT}/v1"
      },
      "models": {
          "${FOUNDRY_MODEL_NAME}": {
              "name": "Phi 4"
          }
      }
    }
  }
}
EOF
)

# Write provider JSON to a temp file
TMP_PROVIDER=$(mktemp)
echo "$PROVIDER_JSON" > "$TMP_PROVIDER"

# Merge safely
jq -s 'reduce .[] as $item ({}; . * $item)' \
    "$CONFIG_FILE" "$TMP_PROVIDER" \
    > "${CONFIG_FILE}.tmp"

mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"
rm "$TMP_PROVIDER"

echo "✓ Foundry Local provider added to $CONFIG_FILE"
```

---

## Ollama

WARNING: This section is still AI authored and untested. Please proceed with caution and verify commands before running.

This option is best for:

- summarization, rewriting, formatting
- quick “what does this do?” questions
- drafting comments and docs
- lightweight code suggestions where you’ll review changes

### Install and start Ollama

Follow the Ollama install instructions for your OS.

Verify the daemon is running (default port is commonly `11434`):

```bash
curl -s http://localhost:11434/api/tags | head
```

### Pull a model

Pick a model that fits your hardware.

```bash
ollama pull llama3.1
```

### Configure OpenCode to use Ollama

OpenCode can be configured to use different providers via its configuration mechanism.

Because OpenCode’s provider config surface can evolve, use this approach:

1. Run `opencode serve --help` and/or consult https://opencode.ai/docs/ for the current provider configuration.
2. Configure OpenCode to point at **Ollama**.

Most tooling uses an OpenAI-compatible base URL for Ollama (often `http://localhost:11434/v1`). If OpenCode supports OpenAI-compatible providers, the config typically consists of:

- a **base URL** pointing at your local Ollama endpoint
- a **model name** (the Ollama model you pulled)
- an **API key** (often unused locally; some clients require a dummy value)

Document your chosen OpenCode settings here once confirmed:

- OpenCode provider: `ollama` or `openai-compatible` (TBD)
- Base URL: `http://localhost:11434/...` (TBD)
- Model: `llama3.1` (example)

### Run Worklog TUI with OpenCode (Ollama)

```powershell
$env:OPENCODE_SERVER_PORT = 51625
wl tui
```

Press `O`, wait for `[OK]`, then try:

```
Summarize the selected work item in 3 bullets.
```

---

## Task routing guidance (what to run locally vs hosted)

Good local (Ollama) candidates (tasks that are common in software development and usually don’t require large-model capabilities):

- summarize work items, rewrite descriptions
- propose tags, title cleanups, release notes
- quick “explain this file” or “list risks”
- run tests, interpret failures, and propose follow-up work items (flaky tests, coverage gaps, slow suites)

Prefer a hosted model (Foundry) candidates (tasks where larger-model reasoning, broader knowledge, or higher success rate is worth it):

- multi-file refactors
- complex debugging and test failure reasoning
- changes you plan to PR without heavy manual review

---

## Troubleshooting

### OpenCode server won’t start

- Check `opencode` is on `PATH`: `which opencode`
- Check port conflicts (Unix): `lsof -i :$env:OPENCODE_SERVER_PORT`
- Check port conflicts (PowerShell): `Get-NetTCPConnection -LocalPort $env:OPENCODE_SERVER_PORT`
- Start manually to see logs: `opencode serve --port $env:OPENCODE_SERVER_PORT`

### Ollama connection issues

- Confirm Ollama is running: `curl -s http://localhost:11434/api/tags`
- Confirm your chosen model exists locally: `ollama list`

### Foundry auth/endpoint issues

- Double-check endpoint shape vs your OpenCode provider mode
- Ensure the API key is present in the environment OpenCode is using

---

## Appendix: WSL networking setup for Foundry Local

On my configuration of WSL and Winows 11, WSL cannot reach services running on Windows localhost by default. The following steps fix this.

## Check Windows Firewall is not blocking WSL activity

In Admin Powershell:

```powershell
Get-NetFirewallRule -DisplayName "*WSL*" | Format-Table
```

If there is no result then:

```Powershell
New-NetFirewallRule -DisplayName "WSL2 Allow Loopback" `
  -Direction Inbound -Action Allow -Protocol TCP `
  -LocalPort $FOUNDRY_PORT
```

## Force Windows to expose loopback to WSL

In Admin Powershell:

```Powershell
netsh interface portproxy add v4tov4 listenport=$FOUNDRY_PORT listenaddress=0.0.0.0 connectport=$FOUNDRY_PORT connectaddress=127.0.0.1
```

## Make a query

In WSL get the Windows IP:

```bash
export WIN_HOST_IP=$(ip route show default | awk '{print $3}')
export FOUNDRY_PORT=65000  # or your chosen port
export FOUNDRY_MODEL_NAME="phi-4-openvino-gpu:1" # be sure to select the right variant for your hardware

payload=$(jq -n --arg model "$FOUNDRY_MODEL_NAME" \
  '{model:$model, messages:[{role:"user", content:"Hello World!"}] }')

resp=$(curl -sS -X POST "http://$WIN_HOST_IP:$FOUNDRY_PORT/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d "$payload")

echo "$resp" | jq -r '.choices[0].message.content'
```

---

## References

- Worklog OpenCode integration: [docs/opencode-tui.md](docs/opencode-tui.md)
- OpenCode documentation: https://opencode.ai/docs/
- Ollama documentation: https://ollama.com/
