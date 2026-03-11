# Setup — Interactive Walkthrough

Walk the user through setting up their Personal OS vault. Ask questions, customize files based on answers, and create starter content.

## Step 1: Understand the user

Ask:
1. **What do you do?** (role, company, domain) — this shapes the CLAUDE.md context and domain folders
2. **What are your main work areas?** The defaults are Building (making things), Thinking (intellectual life), Working (business operations), Living (personal), Relating (people). Ask if they want to rename or add any. **For each domain they keep or add, ask them to pick an emoji that represents it.** Defaults:
   - 🔨 Building
   - 🧠 Thinking
   - 📋 Working
   - 🏠 Living
   - 👤 Relating
   - 🗂️ Archive

   But they should pick what resonates — a marketer might want 📣 Campaigns instead of 🔨 Building; an investor might want 💰 Deals instead of 📋 Working; a researcher might want 🔬 Research instead of 🧠 Thinking. These emojis appear as **domain markers** in `/loops` and `/commitments` output, so they should be instantly recognizable to the user.

3. **What task manager do you use?** (Linear, Jira, Asana, Todoist, none) — this vault surfaces open loops but real task management lives elsewhere.
4. **What tags make sense for your work?** Suggest some based on their role.

## Step 2: Customize CLAUDE.md and domain emojis

Based on their answers, update `CLAUDE.md`:
- Replace the description with their actual role and context
- Update the domain folder names if they changed any
- Update the suggested tags list
- Update the "tasks live in [tool]" reference to their actual task manager
- Rename any domain folders if they chose different names (and update all references)
- **Update the domain emoji map** in the "Open Loops — Priority Inference" section of `CLAUDE.md` to reflect their chosen emojis and domain names
- **Update `.claude/commands/loops.md`** — replace the default domain emoji list with their custom mapping
- **Update `.claude/commands/commitments.md`** — if it references domain grouping, update there too

## Step 3: Configure MCP Connectors

Explain to the user:

> This vault can pull context from your work tools using MCP (Model Context Protocol) servers. These are optional — the vault works without them — but they're what make `/inbox` powerful. Each connector feeds a different type of data into your inbox.

Ask which of these they use, then walk through configuration for each:

### Calendar & Meetings
**Tools**: Google Calendar, Outlook, Granola, Fireflies, Otter.ai

If they record meetings (Granola, Fireflies, etc.):
- The `/inbox meetings` command will pull transcripts, extract action items, decisions, and commitments
- Action items like "you will..." or "[Name] to..." get captured as `- [ ]` tasks
- Attendee names get linked as `[[05-Relating/Name]]` automatically
- Configure in `.claude/commands/inbox.md` under the "meetings" section

**What to tell them**: "After every meeting, the system can extract what you owe, what others owe you (`@waiting`), and key decisions — without you writing anything down."

### Email
**Tools**: Gmail, Outlook

If they connect email:
- The `/inbox` command can surface recent threads, follow-ups owed, and stale conversations
- Email contacts get cross-referenced with `05-Relating/` people notes
- Configure email MCP tool calls in the "email" section of `.claude/commands/inbox.md`

**What to tell them**: "Email becomes a source of action items and relationship signals, not just a thing you check separately."

### CRM / Pipeline
**Tools**: Salesforce, HubSpot, Affinity, or internal tools

If they use a CRM:
- The `/inbox` command can pull attention flags, stale interactions, deal updates, and relationship signals
- Company mentions in notes can be cross-referenced against CRM data
- Configure CRM MCP tool calls in the "crm" section of `.claude/commands/inbox.md`

**What to tell them**: "Your CRM becomes a feed into the thinking system — stale deals, stoplight changes, and follow-ups surface in your daily inbox pull."

### Task Board
**Tools**: Linear, Jira, Asana, GitHub Issues

If they use a task board:
- The `/inbox` command can pull assigned tickets, recently updated items, and blocked work
- This vault does NOT replace the task board — it surfaces task context alongside thinking
- Configure task board MCP tool calls in the "tasks" section of `.claude/commands/inbox.md`

**What to tell them**: "Your tickets show up in context with everything else — meeting notes, patterns, people — instead of living in a silo."

### Notion / Docs
**Tools**: Notion, Google Docs, Confluence

If they use Notion or similar:
- Can search across workspace and connected sources for relevant context
- Useful for cross-referencing — "does this inbox note mention something we already have docs on?"
- Configure in `.claude/commands/inbox.md`

### No MCP / Manual Only
If they don't want to set up connectors yet:
- The vault works perfectly with just manual capture to `00-Inbox/`
- `/triage`, `/distill`, `/loops`, `/review`, `/find-connections` all work without any external connections
- They can add connectors later — just edit `.claude/commands/inbox.md`

**After configuring**, update `.claude/commands/inbox.md` with the actual MCP tool calls for their stack. Show them the file and explain: "This is just a markdown prompt — you can edit it anytime to add or remove sources."

## Step 4: Configure Data Types

Walk through how each type of information flows through the system:

### Action Items / Todos
- Captured as `- [ ]` checkboxes wherever they appear (meeting notes, brain dumps, project updates)
- Use `- [ ] @waiting [person]` for items blocked on others
- Surface via `/loops` command
- Real task management lives in their task manager — these are thinking-layer items
- **Convention**: Action items live *inside* the note they came from (project, pattern, or person note), not in a separate file

### Patterns / Learnings
- Title as claims, not topics: "X beats Y for Z" not "Notes on X"
- Start as `status: seed`, promote to `growing` then `evergreen` over time
- Live in the domain folder they belong to (Building, Thinking, Working)
- Get indexed in `_patterns.md` files via `/distill`
- **Convention**: One insight per note. If a brain dump has 3 insights, create 3 pattern notes.

### People
- One note per person in `05-Relating/`
- Include role, company, key context, and interaction history
- Link to people from other notes using `[[05-Relating/Name]]`
- Meeting notes and action items should reference people as wikilinks
- **Convention**: Use first name for filename unless ambiguous

### Projects
- One note per active project in `01-Building/`
- Include goal, key decisions (link to pattern notes), status, and a running log
- Action items live inline as `- [ ]` so they surface in `/loops`
- Archive to `07-Archive/` when done
- **Convention**: Log entries are dated. Key decisions link to pattern notes.

### References
- Things you read, watched, or were sent — articles, papers, talks, books
- Live in `02-Thinking/`
- Extract patterns into separate notes and link back
- **Convention**: "Summary (my words)" section forces you to process, not just save

### Meeting Notes
- If using a meeting recorder MCP, these get pulled automatically via `/inbox meetings`
- If manual, dump raw notes into `00-Inbox/` and `/triage` routes them
- Action items get extracted as `- [ ]`, people get linked, decisions get noted
- The raw meeting note can be archived or deleted after processing

### Brain Dumps
- Drop anything into `00-Inbox/` — typos, fragments, half-thoughts
- `/triage` will: extract patterns, pull out action items, route to the right domain, archive the rest
- **Convention**: Don't self-edit at capture time. The system handles formatting.

## Step 5: Personalize the look

Ask: **"Do you want to customize how your vault looks? I can set up a custom theme — accent color, font, dark/light mode. Or we can skip this and you can always just ask me to change the styling anytime while we're working together."**

If they want to customize now, ask:
1. **Dark or light mode?**
2. **Accent color** — suggest a few (pink, blue, green, orange, purple, teal) or take any hex code / color name
3. **Font** — Inter, JetBrains Mono, Lora, system default, or any Google Font

Generate `.obsidian/snippets/personal-os.css` with their choices. Derive all secondary colors (hover, glow, borders, code bg, selection, scrollbar) from the single accent color. Tell them to enable it in Obsidian → Settings → Appearance → CSS snippets.

If they skip, move on — they can ask "make my headers blue" or "switch to dark mode" at any point in any future conversation and you'll generate or update the CSS snippet then.

## Step 6: Customize `/conductor` (engineers only)

Ask if they're an engineer with git repos to scan.
- If yes: ask for their workspace path and update `.claude/commands/conductor.md`
- If no: let them know they can delete this command — it's optional

## Step 7: Create starter content

Create 2-3 starter notes to demonstrate the system:

1. **A project note** in `01-Building/` — ask what they're currently working on. Create it with the Project template, filling in what they tell you.

2. **A person note** in `05-Relating/` — ask for one person they work with frequently. Create it with the Person template.

3. **A seed pattern** — ask: "What's one thing you've learned recently in your work that you'd want to remember?" Create a claim-style pattern note from their answer.

## Step 8: Demo the workflow

1. Create a messy test note in `00-Inbox/` with a mix of content (an action item, a half-formed idea, and a person mention) based on what they've told you about their work.
2. Run `/triage` on it so they can see the routing in action.
3. Run `/loops` to show them the open item that was extracted.
4. Run `/find-connections` to show how linking works.

## Step 9: Summarize

Tell them:

**Your daily rhythm:**
- Capture to `00-Inbox/` throughout the day (fast, messy, no formatting needed)
- `/inbox` once to pull from connected tools
- `/triage` to route and process (investigation requests auto-delegate to background agents)
- `/loops` to check open items by priority
- `/commitments` to check what you owe people and what's overdue

**Your weekly rhythm:**
- `/review` — the metacognition pass (what changed, what's emerging, what's orphaned)

**When you learn something:**
- `/distill` — extract patterns from any raw input

**Maintenance:**
- `/find-connections` — keep the knowledge graph connected

**Key reminders:**
- Commands are just markdown files in `.claude/commands/` — edit them anytime
- The vault grows by domain, not by project — patterns compound across everything you do
- Flat until it hurts — don't create structure you don't need yet
- Link aggressively, tag sparingly
- Your domain emojis show up in `/loops` and `/commitments` — change them anytime in `CLAUDE.md`

Ask if they have questions or want to adjust anything.
