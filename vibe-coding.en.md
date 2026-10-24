# Hack on Vilausity yourself

[中文](vibe-coding.md)

Two ways:

- **Change the source**: Need a new feature? Open Vilausity's own source in Vilausity and say what you want right there: Claude makes the change, you try it. When it's done, build an installer and install it over your old version
- **Leave the code alone**: Turn on the local API and let your scripts and bots watch Vilausity and tell it what to do

## Setup

You'll need:

- **Vilausity** and an API provider that works: developing is just chatting in Vilausity
- **Git**: clones the source and records every change, so you can go back when something breaks
- **Node.js**: builds, runs and packages Vilausity

No need to install them yourself. Make a folder for the code (say `D:\Vilausity-dev`), open it in Vilausity, start a new session, and paste in all of this:

```text
Set up a Vilausity development environment in the current folder. Go one step at a time, and check that each step worked before moving on:

1. Check whether Git is installed. If not, install it with winget (add --source winget). If that fails, tell me where to download it.
2. Clone https://github.com/Teabie666/vilausity-claude-code-gui-shell into the current folder itself, not into a subfolder. If the folder has anything else in it (apart from Claude Code's own .claude folder), stop and ask me. If GitHub can't be reached, stop and tell me too. If Git has no user name and email set yet, ask me for them and set them for this repository only.
3. Read CLAUDE.md and docs/DEVELOPING.md in the repository, install whatever the "环境" (environment) section needs that's missing, then install the dependencies.
4. Run npm run dev in the background and check that the dev instance's window opens.

Notes:
- Newly installed software may not be found in the current terminal; refresh PATH or use full paths.
- If npm or Electron downloads are too slow or fail, switch to a mirror (such as npmmirror in China) for these commands only; don't change my global settings.

When everything's done, tell me what you installed and where. If you newly installed Git or Node.js, remind me to quit Vilausity completely and open it again.
```

Windows may ask for permission while software installs, and in Manual mode you'll keep having to approve commands (Auto mode is a good idea for the setup). At the end a new Vilausity window pops up: that's the dev instance, and if it opens, you're all set.

## Let's cook!

Open `D:\Vilausity-dev` (or wherever yours is) in Vilausity, start a new session and just say what you want. The repository's CLAUDE.md spells out the rules and commands, and Claude reads it on its own.

- For bigger features, switch to plan mode first (Shift+Tab), and let it start once you've seen the plan
- When it's done, have Claude start a dev instance and try it. The dev instance has its own windows and data, apart from the Vilausity you're using. If something's off, keep talking
- Happy with it? Have it commit: the changes go into Git, and if something breaks later you can go back to this point

About the dev instance:

- The first time it opens, enter your API key again (keys are stored encrypted in the data of the Vilausity you're using and can't be carried over)
- It shares conversation history with the Vilausity you're using: delete a conversation in the dev instance and it's gone there too (the dev instance is no sandbox! It's just a test build of Vilausity, and whatever it does happens on your computer for real)
- Don't open a conversation that's busy (the ones with a green dot in the session list) in the dev instance, or things blow up!

## All done? Switch to your own version

- Have Claude build the installer, and one shows up in the `release` folder. Installing it replaces your old Vilausity like a normal update: settings, API providers and conversations all stay, nothing gets lost
- The installer isn't signed (my official ones aren't either), so Windows stops it once: click "More info" → "Run anyway"
- When a new official version comes out, don't just install the official installer: it would wipe out your changes. Have Claude pull the new code, merge it with your changes, then build and install again; where both sides changed the same spot it sorts things out, and asks you when it's unsure
- To go back to the official version, just install the official installer
- Not changing anything, just want to build from source yourself? Once set up, have it build the installer right away

## Leave the code alone: local API

Settings (Ctrl+,) → "Local API" → turn on "Api: Enabled". Programs on this computer can then:

- See which windows are open, whether each conversation is working or waiting for you, and how much it has cost
- Open folders, files and conversations, and run Vilausity's commands
- With "Api: Allow Send" turned on too, send messages to Claude directly (without it they can only fill in the message box, and you send it)

Only local programs that can read the key file can connect, web pages can't; in an administrator window it's look but don't touch.

Examples are in [examples/local-api](examples/local-api/):

- `notify.py`: tells you when Claude is waiting for your OK or has finished a turn
- `vilaus-api.ps1`: calls the API right from PowerShell

Want to hook up your own stuff (a chat bot, a desktop widget, a little tool you wrote)? Hand [docs/local-api.md](docs/local-api.md) to Claude, say what you want, and let it write the code. If the API doesn't have what you need, go back up and have Claude add it to Vilausity.
