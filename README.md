# Wait with God

Turn AI waiting time into Scripture time.

While Claude is working, a small band above the prompt shows today's verse (Berean Standard Bible,
via the free bible.helloao.org API). Each wait hides a little more of it:

| Looks today | Step   | What you see                          |
| ----------- | ------ | ------------------------------------- |
| 1-6         | Read   | The full verse                        |
| 7-15        | Repeat | A few words blanked, building to about a third |
| 16-24       | Recall | Those words and more cut to first letters, building to most |
| 25+         | Check  | Every word reduced to its first letter; Reveal, then "Got it" |

The band disappears the instant Claude needs you. Focus it (click, or ctrl+x tab) and press `r` to reveal or `g` for Got it.

Everyone sees the same verse on the same day (a 31-verse cycle), the same as the
[Mac app](https://waitwithgod.com).

## Install

Needs Claude Code 2.1.287 or later (`claude update`). In Claude Code:

```
/plugin marketplace add ToastMobile/wait-with-god-plugins
/plugin install wait-with-god@wait-with-god
```

## Commands

| Command             | What it does                                                         |
| ------------------- | -------------------------------------------------------------------- |
| `/wait`             | Today's verse and your totals: time redeemed today and all time, reviews, verses memorized, workday streak |
| `/wait copy`        | Copies the whole verse, never the blanked one                        |
| `/wait next`        | Switches today's verse to the next one you haven't memorized, from Read |
| `/wait hide`        | Hides the band for an hour; `/wait hide today` for the rest of the day |
| `/wait show`        | Shows it again                                                       |
| `/wait reset`       | Restarts today's verse at Read                                       |

`/wait` runs right away, even while Claude is working. Nothing counts while the band is hidden.

## Privacy

The only network request is for the verse text from bible.helloao.org, once per verse. Your stats stay in the
plugin's own store under your Claude config directory. Nothing is sent anywhere else.

## Develop

From a checkout:

```
claude --plugin-dir ./plugin
claude plugin validate ./plugin
claude plugin test ./plugin
```

Add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json` (`env` block) to load it in the desktop
Code tab.

---

Brought to you by [Versle](https://get.versle.app/p/waitwithgod). Toast Apps and Software LLC.
