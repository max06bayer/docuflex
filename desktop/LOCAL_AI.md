# Local Qwen runtime

Qwen 3.5 4B Q4_K_M is offered on the shipped macOS arm64, Windows x64 and Linux x64 desktop builds. The website never downloads or starts a local model runtime.

- Apple Silicon keeps the bundled, pinned Ollama runtime and uses Metal.
- Windows/Linux download checksum-pinned official Ollama 0.40.13 standalone archives together with the model. Intel/AMD **CPU** brands both use the x64 executable; actual display-adapter PCI vendor IDs select additional GPU libraries. The base archive includes CUDA/Vulkan, and AMD-only systems also receive the ROCm archive. Mixed NVIDIA/AMD systems use the base CUDA/Vulkan runtime, avoiding an unnecessary ROCm download.
- Files install beneath `~/.docuflex/ollama/runtimes`, separately from the model store. Downloads resume, verify full SHA-256 hashes before extraction, install atomically from a private staging folder, and retain progress when paused. No OS driver installer, global Ollama service or administrator access is used.
- Windows starts an owned PowerShell-supervised `ollama.exe serve`; Linux/macOS use the shell supervisor. All listen on an ephemeral loopback port with cloud features disabled. Quitting terminates the owned process tree.
- Status checks do not start the daemon or load the model. The model loads on inference and remains subject to the existing idle/document-unload policy.

## GPU verification

Ollama chooses its GPU backend automatically. Compatible vendor drivers are required; Linux packages depend on the Vulkan loader. Installing runtime libraries cannot supply a missing kernel/display driver or make unsupported hardware compatible.

The app samples `/api/ps` after inference starts and while Qwen is busy. `size_vram` and `size` determine full GPU, mixed GPU/CPU, CPU-only or unknown placement. This is **model-memory placement, not a GPU-utilization percentage**. Idle status labels any cached result as “Last run”. The model menu and download popup show this information; they never label a detected adapter as verified GPU inference.

## Validation still required on target hardware

Fixture tests cover Windows/Linux runtime selection, download resume and hashes, ZIP/Zstandard extraction, traversal rejection and GPU/CPU/mixed reporting. Real CUDA, ROCm and Intel/AMD Vulkan inference must also be checked on Windows/Linux hardware before publishing the release. Retain the release as a draft while that validation is pending.

Official references: https://github.com/ollama/ollama/blob/v0.40.13/docs/gpu.mdx and https://github.com/ollama/ollama/blob/v0.40.13/docs/windows.mdx.
