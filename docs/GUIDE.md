# Multiplayer mode: the guide

**multiplayer** lets a team work on one project with Claude Code at the same time, without stepping on each other. Each person's Claude knows what everyone else is working on, what the team has decided, and what's been handed over. Git happens for you, safely.

You keep working the way you already do: describe what you want, and Claude does it. The plugin adds the teamwork around it.

---

## Get started

### If you're setting up the team (one person, once)

1. **Install the plugin.** In Claude Code, type:
   ```
   /plugin install multiplayer --marketplace mjrichar09/MultiplayerVibeCoding
   ```
   When it asks where to install, choose **"Install for all collaborators on this repository (project scope)"**, so your teammates are offered the plugin automatically.

   If that doesn't work on your version, run these two lines in a terminal instead:
   ```
   claude plugin marketplace add mjrichar09/MultiplayerVibeCoding
   claude plugin install multiplayer@multiplayer-vibe-coding --scope project
   ```
2. **Open Claude Code in your project and say:**
   > Set up multiplayer for this repo.
3. **Review and merge the "team setup" pull request** Claude opens. It adds:
   - a team `CLAUDE.md`, the project briefing every agent reads (Claude fills in what it can), including a "Getting set up" section for new teammates;
   - shared settings that turn on the plugin for teammates and block risky git commands;
   - a pull request template.
4. **Say yes if Claude offers branch protection.** It makes GitHub refuse to merge anything whose tests fail.
5. **Tell your teammates to join.**

### If you're joining a team

1. **Pull the latest code and open Claude Code in the project.**
2. **Accept the "trust this folder" prompt.** This turns on the team's shared settings and offers you the plugin. Install it if asked (choose project scope), or use the install command above.
3. **Start a new session.** You join the team automatically. The first thing Claude shows is who's on the team and what they're working on.
4. **Get set up to run the project.** On your first session, Claude reads the "Getting set up" section of `CLAUDE.md` and helps you install whatever's missing (tools, environment variables, access).

### Check that it's working

Ask:
> Is multiplayer working?

Claude checks everything and tells you how to fix anything that's missing.

> **Using Claude Code in the cloud** (on the web or from the mobile app)? Add an environment variable `MULTIPLAYER_USER` set to your team username in the cloud environment's settings first. Cloud sessions all commit under the same shared name, so the plugin needs to be told who you are.

---

## A day in multiplayer mode

Here's what working together looks like. Nearly all of it happens automatically.

**1. You start a session.** Claude opens with a short summary:

```
multiplayer · you are bob · teammates (2): alice, carol
Your claims: none
New team decisions:
- Store all money as integer cents (alice, 2h ago)
Team notes:
- carol: Staging database is down today; test locally
Teammates' claims:
alice (1):
  - redo-checkout: Redo checkout flow [src/checkout/**]
```

**2. You give Claude a task.** For example: "Add a refund button to the order page."
- Claude **claims** the task and the files it expects to touch, so teammates' agents see it.
- It starts a **fresh branch** for the task from the latest code. You never have to think about branches.

**3. Claude works.**
- If it needs to edit a file a teammate is working on, it **stops and asks you first**, for example: "Alice is working on `src/checkout/cart.ts`."
- If a teammate's finished work lands in files you're using, Claude **merges it in** at a good moment, sorting out any conflicts with you.

**4. You're done.** Claude pushes the work and opens a **pull request**.
- Once the PR's checks pass (and your team approves, if you require that), Claude merges it.
- Your claim is **released**, the old branch is **cleaned up**, and you're back on the latest code, ready for the next task.

**5. Along the way, things worth sharing get shared:**
- When you and Claude **settle a design choice**, it's recorded as a team decision.
- When Claude learns something teammates need, like a broken setup step, it posts a **team note**. If it's a setup step every newcomer will need, it's also added to `CLAUDE.md`'s "Getting set up" section, since notes fade after a few days.
- Both show up in teammates' summaries at their next session.

---

## The key pieces

| Piece | What it is | Why it matters |
|---|---|---|
| **Team** | Everyone who has joined this repo. Joining is automatic. | Everyone's Claude knows who else is working. |
| **Shared state** | A separate branch in your repo (`multiplayer-state`) holding claims, decisions, notes, and handoffs. On your machine it's the `.multiplayer/` folder. | No server or account needed. It syncs through git like everything else. |
| **Claims** | "I'm working on *this task*, in *these files*." Made automatically before Claude edits. | Agents see each other's work and avoid collisions. |
| **Session summary** | The short briefing at the start of every session. | Each session starts knowing what the team is doing. |
| **Warnings** | Claude pauses before editing a file a teammate has claimed, or one changed in their open pull request. | Catches overlaps early instead of at merge time. Warnings never block you. |
| **Task branches** | One task, one branch, one pull request. Created and cleaned up automatically. | Clean history; nobody works directly on `main`. |
| **Git autopilot** | Keeps your branch up to date by **merging** (never rebasing), only at moments when nothing can be lost. | No git expertise needed, and no "my work disappeared". |
| **Decisions** | Short records of settled choices ("store money as integer cents"). Also listed in `CLAUDE.md`. | New sessions and teammates follow the same rules. |
| **Team notes** | Quick heads-ups that fade after a few days ("staging is down"). | Saves everyone from rediscovering the same problem. |
| **Handoffs** | Passing your work, branch, and notes to a named teammate. | Work continues smoothly when someone is away. |
| **Guard rails** | Merges only when checks pass. Force-pushes, rebases, pushing straight to `main`, and reading secret `.env` files are blocked. Merged changes can be undone safely. | Mistakes stay small and fixable. |

---

## Things you can say

You don't need to learn any commands. Ask in plain language:

| Say | What happens |
|---|---|
| "What's the team working on?" | Everyone's claims, recent decisions, and notes |
| "Hand this to Alice." | Your work, branch, and notes go to Alice; her next session picks them up |
| "We decided to use Postgres. Record that." | A team decision every teammate's Claude will see |
| "Tell the team the API key rotated." | A team note in everyone's next summary |
| "Bring my branch up to date." | Merges the latest code in and resolves conflicts with you |
| "Undo PR #42." | A pull request that safely reverses #42, plus a note to the team |
| "Split this across parallel agents." | Several agents work on separate parts at once; the lead agent combines their work |
| "Is multiplayer working?" | A health check with fixes |

Claude will also **suggest a handoff** when you mention you're going away or are stuck. It nudges you when one of your claims has gone quiet for a couple of days.

---

## Good habits

- **One task per session.** Finish it, or hand it off, before starting something unrelated.
- **Let Claude commit as it goes.** Small, frequent commits make automatic updates safe.
- **Push before switching machines.** That way your next session, on any device, can pick up the branch.
- **Review pull requests.** Agents make sure the checks are green; a human eye still helps.
- **Don't let merging to `main` deploy to production automatically.** Use a staging site plus a manual "release" step. A bad merge can be reverted; emails already sent and data already changed can't. See "Deploying safely" in the [README](../README.md#deploying-safely-keep-merged-separate-from-live).
- **Keep `CLAUDE.md` short and true.** It's what every agent reads first. Claude keeps its "Team decisions" section current for you.

---

## Several agents, apps, and devices

- **Parallel agents:**
  - *Subagents* (one Claude splitting work into helpers) work automatically: the main agent owns git and the helpers just edit.
  - *Separate sessions or tools like Orca and herdr:* ask "split this across parallel agents". Claude gives each agent its own folder and branch, then combines the results.
- **Terminal, desktop app, and Remote Control** on the same project all work. If two sessions share one folder at the same time, automatic git steps pause until one finishes, and you're warned if both edit the same file.
- **Cloud sessions:** set `MULTIPLAYER_USER` (see above). Your claims record which machine or session made them, so your own sessions warn each other too.

---

## When something seems off

1. Ask **"Is multiplayer working?"**, then follow its fixes.
2. Common causes:

| Symptom | Likely cause |
|---|---|
| No team summary at session start | Plugin not installed or enabled, folder not trusted, or the repo isn't set up yet |
| "multiplayer is paused in this session" | Cloud session without `MULTIPLAYER_USER` |
| Claude keeps asking permission for git commands, or can't merge in auto mode | The team-setup pull request isn't merged yet, or the folder isn't trusted |
| No warnings about teammates' pull requests | The GitHub CLI isn't installed or signed in (`gh auth login`). Claim warnings still work without it. |

3. Still stuck? See [Troubleshooting](../README.md#troubleshooting) in the README.

---

## Where things live (for the curious)

- **`.multiplayer/`** in your project: your local copy of the shared team state. It's kept out of your own commits automatically.
  - `claims/`: who's working on what
  - `decisions/`: the team's decisions
  - `notes/`: team notes
  - `handoffs/`: work passed between people
  - `members/`: who's on the team
  - `multiplayer.config.json`: team settings, such as how many days before a claim counts as stale
- **`multiplayer-state`**: the branch on GitHub that syncs all of the above. Don't merge it into `main`; it's separate on purpose.
- **`CLAUDE.md`**: the project briefing every agent reads. It includes the team's decisions.
- **`.claude/settings.json`**: shared permissions and safety rules from the team-setup pull request.
