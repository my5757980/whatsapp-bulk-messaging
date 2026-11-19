---
id: 4
title: Full RE Toolchain Setup
stage: general
date: 2026-11-16
surface: agent
model: claude-opus-5-5
feature: none
branch: main
user: Muhammad Yaseen
command: none (free-form prompt)
labels: ["reverse-engineering", "setup", "ghidra", "mcp", "jadx", "apktool", "frida", "mitmproxy"]
links:
  spec: null
  ticket: null
  adr: null
  pr: null
files:
 - C:\Users\ASFAR\RE-Tools\jadx\ (jadx 1.5.6)
 - C:\Users\ASFAR\RE-Tools\apktool\apktool.jar + apktool.bat (apktool 3.0.3, custom wrapper)
 - C:\Users\ASFAR\RE-Tools\ghidra_12.1.4_PUBLIC\ (moved from C:\Users\ASFAR\Downloads\ghidra_12.1.4_PUBLIC_20260921\)
 - C:\Users\ASFAR\RE-Tools\ghidra_12.1.4_PUBLIC\Ghidra\Extensions\GhidraMCP\ (plugin v7.0.0)
 - C:\Users\ASFAR\RE-Tools\pyenv\ (lief, capstone, pefile, pyelftools)
 - C:\Users\ASFAR\RE-Tools\user-PATH-backup-2026-11-16.txt
 - C:\Users\ASFAR\.local\bin\ (uv tools - frida-tools, objection, mitmproxy, bridge-mcp-ghidra)
 - C:\Users\ASFAR\.claude.json (MCP server ghidra-mcp, user scope)
 - HKCU\Environment (Path +5 entries, GHIDRA_INSTALL_DIR, ANDROID_HOME, RE_TOOLS)
 - C:\Users\ASFAR\Desktop\Ghidra 12.1.4.lnk
 - history/prompts/general/4-full-re-toolchain-setup.general.prompt.md
tests:
 - SHA256 verified against GitHub release digests - jadx-1.5.6.zip, apktool_3.0.3.jar, GhidraMCP-7.0.0.zip
 - GhidraMCP extension.properties version=12.1.4 matches installed Ghidra
 - jadx decompiled apksigner.jar into 298 .java files
 - Versions - jadx 1.5.6, apktool 3.0.3, adb 1.0.41, aapt2 2.20, apksigner 0.9, frida 17.26.3, mitmproxy 12.3.1, objection runs, bridge-mcp-ghidra --help OK
 - frida-ls-devices lists the local device
 - pyenv imports lief 1.0.0, capstone, pefile, pyelftools
 - claude mcp get ghidra-mcp reports Connected
---

## Prompt

haaa tum phlayyy kuch setup karoo apnayy mayy poora reverse engineering 1oo% install connect karoooo is ko reday setup karoo phir use karayy gayyy reverse engineering

(follow-up message during the same task, verbatim: "Tool loaded.")

## Response snapshot

Checked hardware first: 3.9 GB RAM, i7-3667U, 31 GB free on C:. Because of the RAM, decided to skip the Android emulator. Researched Ghidra MCP options and chose bethington/ghidra-mcp v7.0.0, which is built for Ghidra 12.1.4 and Java 21.

Installed into C:\Users\ASFAR\RE-Tools:
- jadx 1.5.6
- apktool 3.0.3
- GhidraMCP plugin (installed for the whole Ghidra install)
- Ghidra itself, moved there from Downloads, plus a Desktop shortcut

Installed with uv (Python 3.12): frida-tools, objection, mitmproxy, and the ghidra-mcp bridge. Also created an RE Python venv with lief, capstone, pefile and pyelftools.

Added the tool folders to the user PATH (backed up first) and set GHIDRA_INSTALL_DIR, ANDROID_HOME and RE_TOOLS. Registered ghidra-mcp with Claude Code at user scope; it reports Connected.

Two steps remain for the user, both one-time:
1. Restart Claude Code from a new terminal.
2. Open Ghidra, accept the agreement, and enable GhidraMCPPlugin (File > Configure > Utility > Configure).

## Outcome

- ✅ Impact: Static APK and native RE, traffic interception and Frida tooling are installed and verified. Ghidra is wired to Claude via MCP and waits only for the GUI plugin to be enabled.
- 🧪 Tests: see tests list (hash checks, version checks, jadx decompile smoke test, MCP Connected).
- 📁 Files: tools under C:\Users\ASFAR\RE-Tools and C:\Users\ASFAR\.local\bin; user env vars; ~/.claude.json; Desktop shortcut.
- 🔁 Next prompts: user restarts Claude Code, enables the plugin, then names an RE target.
- 🧠 Reflection: The RAM check changed the plan (no emulator). Picking an MCP plugin built for the exact Ghidra version avoided a source rebuild.

## Evaluation notes (flywheel)

- Failure modes observed: a PowerShell `for` loop cannot be piped directly (wrapped it in a variable); passing `--` through PowerShell to claude was avoided by using Bash.
- Graders run and results (PASS/FAIL): SHA256 x3 PASS; extension version match PASS; jadx smoke PASS; tool versions PASS; MCP Connected PASS.
- Prompt variant (if applicable): N/A
- Next experiment (smallest change to try): After the user enables the plugin, curl http://127.0.0.1:8089/check_connection and list functions of a small binary through ghidra-mcp.
