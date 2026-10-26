import { EmbedBuilder } from 'discord.js';
import { AIProvider } from './ai-provider.js';
import { CapabilityRegistry, CAPABILITY_CATEGORIES, REGISTERED_SLASH_COMMANDS } from './capabilities.js';
import { ResponseService } from './response-service.js';

export const DEFAULT_HELP_TEXT = `**Meet Honey Bot**

Honey Bot lets you manage supported Discord tasks using everyday English instead of memorizing lots of commands.

Just choose the command that matches your goal, then describe what you want in the prompt field.

**Your commands**

• \`/go\` — Ask Honey Bot to perform a supported Discord action. Example: "Ban Alex for repeated harassment."
• \`/modlog\` — Manage moderation logging in plain English. Example: "Set #staff-logs as the log channel and test it."
• \`/diagnose\` — Check the bot's health. Example: "Check whether the bot can access its configured channels."
• \`/undo\` — Reverse a supported action when it is safe and possible. Example: "Undo my last channel rename."
• \`/help\` — Learn how to use Honey Bot. Ask a question or view this guide.

**Getting started**

1. Select a command.
2. Type your request in the prompt field.
3. Mention the relevant person or channel where helpful.
4. Include a reason, duration, or number when needed.
5. Review any clarification or confirmation request.

**A few things to know**

• You can phrase requests naturally; exact wording is not required.
• Honey Bot can perform only actions it supports and is authorized to perform.
• Some actions require permissions or confirmation.
• Moderation actions and supported administrative events can be recorded in a server's configured mod-log channel.
• If something fails, Honey Bot will explain why and suggest the next step.

**Try asking:** "Help me set up moderation logging", "What can you do?", or "Check whether the bot is working".`;

const HELP_QA_PROMPT = `
You are the Honey Bot Help Assistant.
Honey Bot is a secure, natural-language Discord administration and moderation bot with exactly five slash commands:
1. /go: Natural-language execution of supported Discord actions.
   - Channels: Create, delete, edit, move, rename, lock/unlock, set slowmode, and configure channel permission overwrites.
   - Roles: Create, edit, delete, assign, remove, and self-assignable role menus.
   - Moderation: Timeout, remove timeout, kick, ban, unban, change nickname, purge messages (1-100 limit, 14-day Discord restriction).
   - Community: Announcements, messages, pins, ticket systems, and security audits.
   - Music & Audio: Stream tracks and search YouTube/SoundCloud in voice channels (/go prompt: play <song>, pause, resume, skip, queue, np, volume, stop).
2. /modlog: Free-form moderation log management.
   - Configure log channel, inspect status, test delivery, enable/disable, and troubleshoot permissions.
3. /diagnose: Subsystem health checks, permission audits, and safe self-repairs.
   - Scans Discord permissions, bot configuration, database connectivity, and bot code health.
4. /undo: Rollback of recent reversible actions (channels created, roles created, channel renames).
   - Bans, kicks, purges, and channel deletions are consequential and cannot be reversed via /undo.
5. /help: Introductory guide and capability assistance with an optional natural-language prompt.

CRITICAL RULES:
1. NEVER output internal action names as slash commands (e.g. NEVER say /timeout_member or /rename_channel).
   All internal capabilities are invoked via /go (e.g. /go prompt: Timeout Alex for 10 minutes).
2. No emojis or persona fluff. Bullet points must each begin on a fresh newline.
3. Return output strictly as a JSON object: {"answer": "your answer here"}.
`;

export class HelpManager {
  static getIntroductoryGuide() {
    return DEFAULT_HELP_TEXT;
  }

  static getDefaultHelp() {
    return DEFAULT_HELP_TEXT;
  }

  static getHelpEmbed() {
    const categories = CapabilityRegistry.getAllCategories();
    const categoryBullets = categories.map(cat => `• **${cat.name}** — ${cat.description}`).join('\n');

    return new EmbedBuilder()
      .setTitle('Meet Honey Bot — Natural-Language Server Administration')
      .setDescription(DEFAULT_HELP_TEXT)
      .setColor(0xfee75c)
      .addFields([
        {
          name: 'Core Registered Slash Commands',
          value: '• `/go` (required prompt)\n• `/modlog` (required prompt)\n• `/diagnose` (optional prompt)\n• `/undo` (optional prompt)\n• `/help` (optional prompt)'
        },
        {
          name: 'Supported Capability Categories',
          value: categoryBullets.slice(0, 1024)
        },
        {
          name: 'Authoritative Capability Discovery',
          value: 'Explore any topic in detail using `/help prompt: <question>`, e.g.:\n• `/help prompt: Show me everything I can do with /go.`\n• `/help prompt: What moderation capabilities are supported?`\n• `/help prompt: Show all capabilities`'
        }
      ]);
  }

  static createHelpEmbed() {
    return this.getHelpEmbed();
  }

  /**
   * Generates the comprehensive, categorized catalog of all executable capabilities.
   */
  static getFullCatalogText() {
    const categories = CapabilityRegistry.getAllCategories();
    const sections = [
      '**Honey Bot Authoritative Capability Catalog**',
      'All administrative capabilities are invoked through the `/go` command using everyday English.',
      'Honey Bot has exactly five top-level slash commands: `/go`, `/modlog`, `/diagnose`, `/undo`, `/help`.',
      ''
    ];

    for (const cat of categories) {
      sections.push(`**${cat.name}**`);
      if (cat.description) sections.push(cat.description);
      const bullets = cat.capabilities.map(cap => {
        const ex = cap.goExample ? `\n  *Example:* \`${cap.goExample}\`` : '';
        return `• **${cap.title}** — ${cap.description}${ex}`;
      });
      sections.push(bullets.join('\n'));
      sections.push('');
    }

    return sections.join('\n').trim();
  }

  /**
   * Answers user questions about Honey Bot features, setup, and capabilities.
   */
  static async answerQuestion(userQuestion, aiProvider = new AIProvider()) {
    const question = String(userQuestion || '').trim();
    if (!question) {
      return DEFAULT_HELP_TEXT;
    }

    const qLower = question.toLowerCase();

    // 1. Comprehensive capability discovery: Full catalog request
    if (/(?:show\s+(?:me\s+)?all\s+capabilities|all\s+capabilities|full\s+catalog|comprehensive\s+catalog|complete\s+list\s+of\s+capabilities|list\s+all\s+capabilities)/i.test(qLower)) {
      return HelpManager.getFullCatalogText();
    }

    // 1b. Interactive Server Dashboard questions
    if (/(?:dashboard|server\s+settings|config\s+center|how\s+do\s+i\s+open\s+the\s+dashboard|access\s+the\s+dashboard)/i.test(qLower)) {
      return (
        '**Honey Bot Server Dashboard & Configuration Center**\n\n' +
        'You can access the interactive in-Discord server dashboard by running `/help` and clicking **"Open Server Dashboard"**, or by asking Honey Bot directly:\n' +
        '• `/go prompt: Open the server dashboard`\n' +
        '• `/help prompt: dashboard`\n\n' +
        '**Dashboard Sections:**\n' +
        '• **Overview** — Live operational health, gateway latency, bot uptime, and configuration completeness.\n' +
        '• **Moderation** — Default timeout lengths, warning escalation thresholds, and kick/ban confirmation requirements.\n' +
        '• **Roles & Access** — Configured operator roles, granted capability groups, and default-deny policies.\n' +
        '• **Modlogs** — Destination audit channel, live event filters, and test delivery verification.\n' +
        '• **Music & Voice** — Playback controls, now-playing track, and queue management.\n' +
        '• **Task Queue** — Active running tasks, progress inspection, and task cancellation.\n' +
        '• **Diagnostics** — Bot permissions, runtime errors, and recovery undo history.\n' +
        '• **Capability Catalog** — Interactive categorized catalog of all supported bot operations.\n\n' +
        '*All dashboard interactions are strictly deterministic, isolated per server, and require zero LLM tokens.*'
      );
    }

    // 2. Everything possible with /go
    if (/(?:everything\s+(?:i\s+can\s+do\s+with\s+)?\/go|what\s+can\s+i\s+do\s+with\s+\/go|what\s+can\s+\/go\s+do|show\s+me\s+everything\s+i\s+can\s+do\s+with\s+\/go)/i.test(qLower)) {
      const categories = CapabilityRegistry.getAllCategories();
      const catLines = categories.map(cat => {
        const topCaps = cat.capabilities.slice(0, 3).map(c => c.title).join(', ');
        return `• **${cat.name}** — ${cat.description}\n  *Key operations:* ${topCaps}`;
      });

      return (
        '**Everything you can do with `/go`**\n\n' +
        'The `/go` command is Honey Bot\'s primary natural-language execution engine. Describe what you want in plain English, and Honey Bot verifies permissions, checks role hierarchy, and executes the appropriate Discord actions.\n\n' +
        '**Supported Capability Categories:**\n' +
        catLines.join('\n\n') + '\n\n' +
        '**Usage Note:** Internal operations are not separate slash commands. Invoke them via `/go prompt: <instruction>`.\n' +
        '*To view all operations for any specific category, ask:* `/help prompt: What moderation capabilities are supported?`'
      );
    }

    // 3. Moderation capabilities
    if (/(?:what\s+moderation\s+capabilities|moderation\s+capabilities|supported\s+moderation|moderation\s+features)/i.test(qLower)) {
      const modCaps = CapabilityRegistry.getByCategory('MODERATION').map(c => CapabilityRegistry.toAuthoritative(c));
      const voiceCaps = CapabilityRegistry.getByCategory('VOICE_MODERATION').map(c => CapabilityRegistry.toAuthoritative(c));

      const modBullets = modCaps.map(c => `• **${c.title}** — ${c.description}\n  *Example:* \`${c.goExample}\``).join('\n');
      const voiceBullets = voiceCaps.map(c => `• **${c.title}** — ${c.description}\n  *Example:* \`${c.goExample}\``).join('\n');

      return (
        '**Supported Moderation Capabilities**\n\n' +
        'All moderation actions are requested through `/go` using natural language and require relevant Discord permissions (`BanMembers`, `KickMembers`, `ModerateMembers`):\n\n' +
        '**Member Moderation**\n' +
        modBullets + '\n\n' +
        '**Voice Channel Moderation**\n' +
        voiceBullets + '\n\n' +
        '*All moderation operations enforce Discord role hierarchy, log to your configured mod-log channel, and require explicit confirmation for destructive actions (bans, kicks).*'
      );
    }

    // 4. Changing individual member permissions
    if (/(?:individual\s+member\s+permissions?|change\s+member\s+permissions?|member\s+channel\s+permissions?|permissions?\s+for\s+(?:a\s+)?member)/i.test(qLower)) {
      return (
        '**Changing Individual Member Permissions**\n\n' +
        'You can configure channel-specific permission overwrites for individual members or roles using `/go`:\n\n' +
        '• **Allow Member Access**: `/go prompt: Allow Priya to view #staff-chat but deny sending messages`\n' +
        '• **File Attachment Permissions**: `/go prompt: Allow @Staff to attach files in #reports`\n' +
        '• **Restrict Member Messaging**: `/go prompt: Deny SendMessages for Alex in #announcements`\n' +
        '• **Restore Default Permissions**: `/go prompt: Reset permissions for Alex in #general`\n\n' +
        '*Requirements: You and the bot must have `ManageChannels` or `ManageRoles` permission. Changes apply immediately to channel overwrites.*'
      );
    }

    // 5. Channel and category operations
    if (/(?:channel\s+and\s+category\s+operations?|all\s+channel\s+and\s+category|channels?\s+and\s+categories)/i.test(qLower)) {
      const chCaps = CapabilityRegistry.getByCategory('CHANNELS').map(c => CapabilityRegistry.toAuthoritative(c));
      const catCaps = CapabilityRegistry.getByCategory('CATEGORIES').map(c => CapabilityRegistry.toAuthoritative(c));

      const chBullets = chCaps.map(c => `• **${c.title}** — ${c.description}\n  *Example:* \`${c.goExample}\``).join('\n');
      const catBullets = catCaps.map(c => `• **${c.title}** — ${c.description}\n  *Example:* \`${c.goExample}\``).join('\n');

      return (
        '**Channel and Category Operations**\n\n' +
        '**Channel Management**\n' +
        chBullets + '\n\n' +
        '**Category Management**\n' +
        catBullets + '\n\n' +
        '*Requires `ManageChannels` permission. Rate limit: Discord allows up to 2 channel renames per 10 minutes per channel.*'
      );
    }

    // 6. What can I undo?
    if (/(?:what\s+can\s+i\s+undo|how\s+does\s+undo\s+work|what\s+actions\s+are\s+reversible)/i.test(qLower)) {
      return (
        '**What you can undo with `/undo`**\n\n' +
        'The `/undo` command safely reverses supported administrative actions from recent sessions:\n\n' +
        '• **Reversible Actions**:\n' +
        '  - Recently created channels (safely removed after confirmation)\n' +
        '  - Recently created roles (safely deleted)\n' +
        '  - Channel renames (restores previous verified channel name)\n' +
        '  - Category creations and renames\n\n' +
        '• **Non-Reversible Actions**:\n' +
        '  - Member bans and kicks (consequential moderation actions cannot be automatically reverted; use `/go prompt: Unban <user>` instead)\n' +
        '  - Bulk message purges (purged messages cannot be recovered from Discord)\n' +
        '  - Deleted channels (deleted Discord channels cannot be restored via API)\n\n' +
        '*Usage: Run `/undo` to rollback the most recent change, or `/undo prompt: Undo the last channel rename`.*'
      );
    }

    // 7. Unavailable or limited features
    if (/(?:which\s+features\s+are\s+unavailable|features\s+(?:are\s+)?limited|unsupported\s+features|what\s+is\s+unsupported|limitations)/i.test(qLower)) {
      return (
        '**Feature Limitations and Unsupported Operations**\n\n' +
        '**Unsupported Features**:\n' +
        '• **No Arbitrary File Hosting**: Honey Bot does not host, upload, or store user files (only configures channel `AttachFiles` permissions and inspects bot code health).\n' +
        '• **No Economy or Leveling**: Honey Bot does not include coins, XP, gambling, or casino games.\n' +
        '• **No Security Bypasses**: The bot strictly enforces role hierarchy, Discord permission boundaries, and anti-nuke protections.\n\n' +
        '**Discord API Technical Limitations**:\n' +
        '• **Bulk Message Purge**: Discord permits purging up to 100 messages at a time, strictly limited to messages newer than 14 days old.\n' +
        '• **Channel Rename Rate Limit**: Discord limits channel renaming to 2 renames per 10 minutes per channel.\n' +
        '• **Role Hierarchy**: The bot cannot assign, edit, or remove roles positioned higher than the bot\'s highest role.'
      );
    }

    // 8. Practical examples of natural-language prompts
    if (/(?:practical\s+examples|natural[- ]language\s+prompts?|example\s+prompts?|prompt\s+examples)/i.test(qLower)) {
      return (
        '**Practical Examples of Natural-Language `/go` Prompts**\n\n' +
        '**Channel & Category Management**\n' +
        '• `/go prompt: Create a private text channel called #vip-lounge for @Supporters`\n' +
        '• `/go prompt: Rename #general to #community-chat`\n' +
        '• `/go prompt: Set slowmode to 10 seconds in #memes`\n' +
        '• `/go prompt: Lock #announcements so only @Staff can speak`\n' +
        '• `/go prompt: Create a category called Archives and move #old-news into it`\n\n' +
        '**Moderation**\n' +
        '• `/go prompt: Timeout Alex for 15 minutes for spamming links`\n' +
        '• `/go prompt: Remove timeout from Sam`\n' +
        '• `/go prompt: Kick @spammer for violating server rules`\n' +
        '• `/go prompt: Purge 25 messages in this channel`\n\n' +
        '**Roles & Members**\n' +
        '• `/go prompt: Create a role called VIP with gold color`\n' +
        '• `/go prompt: Assign role @VIP to Alex`\n' +
        '• `/go prompt: Change Alex\'s nickname to Phoenix`\n\n' +
        '**Music & Audio**\n' +
        '• `/go prompt: play lofi hip hop`\n' +
        '• `/go prompt: volume 80`\n' +
        '• `/go prompt: skip`'
      );
    }

    // 9. File management & operations questions (Grounded accurately in codebase)
    if (/\b(?:files?|attachments?|file operations?|manage files?)\b/i.test(qLower)) {
      return (
        '**File Capabilities in Honey Bot**\n\n' +
        'Honey Bot is an administration and moderation bot and **does not provide arbitrary file hosting, upload, download, or file storage** for server members.\n\n' +
        '**Supported file-related capabilities:**\n' +
        '• **Channel File Permissions**: Configure Discord\'s `AttachFiles` permission for roles and members in any channel using `/go`.\n' +
        '  *Example:* `/go prompt: Allow @Staff to attach files in #reports` or `/go prompt: Deny attach files for @everyone in #general`.\n' +
        '  *Requirement:* Requires `ManageChannels` or `ManageRoles` permission.\n' +
        '• **Bot Health Inspections**: Through `/diagnose`, Honey Bot verifies its own source file integrity (such as detecting empty files or lockfile issues) and can execute safe, reversible self-repairs with automatic backup rollback.\n\n' +
        '*Arbitrary file editing, uploading, and hosting are unsupported.*'
      );
    }

    // 10. /modlog comprehensive capabilities
    if (/(?:explain\s+(?:everything\s+)?(?:i\s+can\s+do\s+with\s+)?\/modlog|mod[- ]?log\s+features?|what\s+can\s+\/modlog\s+do)/i.test(qLower) || (/mod[- ]?log/i.test(qLower) && /everything|all|capabilities|features/i.test(qLower))) {
      return (
        '**What you can do with `/modlog`**\n\n' +
        'The `/modlog` command manages moderation logging in ordinary English:\n' +
        '• **Configuration**: `/modlog prompt: Set #staff-logs as our moderation log channel`\n' +
        '• **Inspection**: `/modlog prompt: Which channel is configured for mod logs?`\n' +
        '• **Verification**: `/modlog prompt: Test the mod-log channel and verify permissions`\n' +
        '• **Disable / Enable**: `/modlog prompt: Disable mod logging` or `/modlog prompt: Turn logging back on`\n' +
        '• **Troubleshooting**: `/modlog prompt: Check why moderation logs are not appearing`\n\n' +
        '*Requires Administrator or Guild Owner permissions. Configurations are saved persistently per server.*'
      );
    }

    // 11. /modlog basic setup
    if (/modlog|mod-log|moderation log/i.test(qLower) && /how|setup|config/i.test(qLower)) {
      return 'To configure moderation logging, use `/modlog` with your request in plain English. For example:\n`/modlog prompt: Set #staff-logs as the mod-log channel and test it`';
    }

    // 12. /diagnose comprehensive capabilities
    if (/(?:diagnos|health|audit\s+bot|check\s+bot)/i.test(qLower) && /how|what|explain/i.test(qLower)) {
      return (
        '**How to use `/diagnose`**\n\n' +
        'Use `/diagnose` for natural-language system diagnostics, model discovery, and safe repairs:\n' +
        '• **General Health**: Run `/diagnose` without a prompt to evaluate Discord gateway, AI inference, and moderation logging.\n' +
        '• **AI Model Discovery**: Run `/diagnose prompt: which AI model are you currently using?` to identify the verified provider, configured model ID, and endpoint.\n' +
        '• **Execution Troubleshooting**: Run `/diagnose prompt: why did my last command fail?` to trace execution errors in the action ledger.\n' +
        '• **Modlog & Persistence**: Run `/diagnose prompt: check whether moderation logs are being persisted`.\n' +
        '• **Safe Repairs**: Run `/diagnose prompt: safely repair the logging configuration if possible` to resolve pending deliveries without repeating actions.'
      );
    }

    // 13. /undo capabilities & limitations
    if (/\bundo\b/i.test(qLower)) {
      if (/ban|kick|purge|delete/i.test(qLower)) {
        return 'Consequential actions such as bans, kicks, message purges, and channel deletions cannot be reversed via `/undo`. You can manually unban users with `/go prompt: Unban <user-id>`.';
      }
      return (
        '**How to use `/undo`**\n\n' +
        'The `/undo` command reverses supported actions from the current session:\n' +
        '• **Reversible Actions**: Recently created channels, recently created roles, and channel renames.\n' +
        '• **Limitations**: Consequential moderation actions (bans, kicks, purges) cannot be undone via `/undo`.\n' +
        '• **Usage**: Run `/undo prompt: Undo the last channel rename` or simply `/undo` to rollback the most recent change.'
      );
    }

    // 14. Broad capabilities overview: "What can Honey Bot do?"
    if (/what\s+(?:can|does)\s+(?:honey\s+bot|you)\s+do|list\s+(?:your\s+)?capabilities|overview|features/i.test(qLower)) {
      return (
        '**Honey Bot Capabilities Overview**\n\n' +
        'Honey Bot lets you manage your Discord server in plain English using five core commands:\n\n' +
        '• **`/go`**: Moderation (ban, unban, kick, timeout, purge), channel management (create, delete, rename, lock, slowmode, permissions), role administration (create, edit, delete, assign, role menus), announcements, and ticket panels.\n' +
        '• **`/modlog`**: Dedicated natural-language moderation log channel setup, status inspection, testing, and toggling.\n' +
        '• **`/diagnose`**: Full subsystem diagnostics, permission audits, and safe self-repairs.\n' +
        '• **`/undo`**: Safe rollback for recently created channels, roles, and renames.\n' +
        '• **`/help`**: Contextual feature assistance and onboarding guides.\n\n' +
        '*All actions are subject to role hierarchy, administrator permissions, and anti-nuke safeguards.*'
      );
    }

    // 15. Ambiguous questions
    if (/^(?:how\s+do\s+i\s+)?(?:delete|remove)\??$/i.test(qLower)) {
      return 'What would you like to delete or remove? You can ask:\n• `/help prompt: How do I purge messages?`\n• `/help prompt: How do I delete a channel?`\n• `/help prompt: How do I delete a role?`\n• `/help prompt: How do I remove a member\'s role?`';
    }

    // 16. Music playback features
    if (/\b(?:music|play\s+song|songs?|audio\s+stream(?:ing)?|voice\s+playback)\b/i.test(qLower)) {
      return 'Honey Bot includes a built-in voice music system. You can stream tracks and control playback using `/go`:\n• `/go prompt: play <song or URL>` — Play a song or search query in your voice channel\n• `/go prompt: pause` / `resume` — Pause or resume playback\n• `/go prompt: skip` — Skip to the next track in queue\n• `/go prompt: queue` — View the current song queue\n• `/go prompt: np` — Show currently playing track\n• `/go prompt: volume <0-150>` — Adjust playback volume\n• `/go prompt: stop` — Stop music and disconnect from voice';
    }

    // 17. Unsupported features (economy, leveling, gambling, hacking)
    if (/\b(?:economy|coins?|leveling|xp|ranks?|gamble|hack|exploit|bypass)\b/i.test(qLower)) {
      return 'Honey Bot does not support economy systems, leveling, or gambling. Honey Bot strictly adheres to security boundaries and cannot perform hacking or unauthorized exploits. It is designed for Discord server administration, moderation, music playback, and diagnostics.';
    }

    // 18. Capability Matrix semantic search
    const matchedCaps = CapabilityRegistry.searchCapabilities(question);
    if (matchedCaps.length > 0) {
      const topCap = matchedCaps[0];
      const ex = topCap.goExample ? `\n\n*Try this prompt:* \`${topCap.goExample}\`` : '';
      const bullets = matchedCaps.slice(0, 4).map(c => `• **${c.title}** — ${c.description} (\`${c.goExample}\`)`).join('\n');
      return (
        `**${topCap.title}**\n${topCap.description}${ex}\n\n` +
        `**Related capabilities:**\n${bullets}`
      );
    }

    try {
      const response = await aiProvider.planWithCustomPrompt(
        HELP_QA_PROMPT,
        `USER QUESTION: "${question}"\nProvide the response strictly as a JSON object:`
      );

      if (typeof response === 'string') {
        try {
          const parsed = JSON.parse(response);
          if (parsed && parsed.answer) return parsed.answer.trim();
        } catch {
          return response.trim();
        }
      }
      if (response && response.answer) return response.answer.trim();
      if (response && response.conversationalResponse) return response.conversationalResponse.trim();
      return DEFAULT_HELP_TEXT;
    } catch {
      return DEFAULT_HELP_TEXT;
    }
  }
}

