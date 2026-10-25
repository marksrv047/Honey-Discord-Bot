import { EmbedBuilder } from 'discord.js';
import { AIProvider } from './ai-provider.js';

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
   - Supported actions:
     • Channels: Create, delete, edit, move, rename, lock/unlock, set slowmode, and configure channel permission overwrites (including AttachFiles, ViewChannel, SendMessages).
     • Roles: Create, edit, delete, assign, remove, and self-assignable role menus.
     • Moderation: Timeout, remove timeout, kick, ban, unban, change nickname, purge messages (1-100 limit, 14-day Discord restriction).
     • Community: Announcements, messages, pins, ticket systems, AutoMod rules, and security audits.
2. /modlog: Free-form moderation log management.
   - Configure log channel, inspect status, test delivery, enable/disable, and troubleshoot permissions.
3. /diagnose: Subsystem health checks, permission audits, and safe self-repairs.
   - Scans Discord permissions, bot configuration, database connectivity, and bot code health.
4. /undo: Rollback of recent reversible actions (channels created, roles created, channel renames).
   - Bans, kicks, purges, and channel deletions are consequential and cannot be reversed via /undo.
5. /help: Introductory guide and capability assistance with an optional natural-language prompt.

CRITICAL IMPLEMENTATION GROUNDING RULES:
1. FILES: Honey Bot does NOT provide arbitrary file hosting, upload/download, or file management for Discord members. The only supported file-related operations are:
   - Setting Discord channel 'AttachFiles' permissions for roles or members via /go.
   - Internal bot health checks (detecting empty files or lockfiles) and safe self-repairs during /diagnose.
   Never claim Honey Bot can upload, download, store, browse, or host files.
2. UNSUPPORTED FEATURES: Honey Bot does NOT support music playback, economy, leveling, gambling, or arbitrary shell commands. If asked, politely clarify that Honey Bot is strictly an administration and moderation bot.
3. AMBIGUOUS QUESTIONS: If a question is ambiguous (e.g. "How do I delete?"), ask one concise clarification question.
4. PERMISSIONS: Remind the user that administrative operations require relevant Discord permissions (Administrator, Manage Channels, Manage Roles, Ban Members, etc.).
5. NO EMOJIS OR FLUFF: Calm, minimal, professional tone. Format bullet points on separate lines.
6. JSON FORMAT: Return output strictly as a JSON object: {"answer": "your answer here"}.
`;

export class HelpManager {
  static getIntroductoryGuide() {
    return DEFAULT_HELP_TEXT;
  }

  static getDefaultHelp() {
    return DEFAULT_HELP_TEXT;
  }

  static getHelpEmbed() {
    return new EmbedBuilder()
      .setTitle('Meet Honey Bot — Natural-Language Server Administration')
      .setDescription(DEFAULT_HELP_TEXT)
      .setColor(0xfee75c)
      .addFields([
        { name: 'Core Commands', value: '`/go`, `/modlog`, `/diagnose`, `/undo`, `/help`' },
        { name: 'Natural Language', value: 'Describe what you want naturally in the prompt field without memorizing rigid syntax.' },
        { name: 'Audit & Safety', value: 'Strict permission checks, role hierarchy enforcement, and anti-nuke safeguards on all actions.' }
      ]);
  }

  static createHelpEmbed() {
    return this.getHelpEmbed();
  }

  static async answerQuestion(userQuestion, aiProvider = new AIProvider()) {
    const question = String(userQuestion || '').trim();
    if (!question) {
      return DEFAULT_HELP_TEXT;
    }

    const qLower = question.toLowerCase();

    // 1. File management & operations questions (Grounded accurately in codebase)
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

    // 2. /modlog comprehensive capabilities
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

    // 3. /modlog basic setup
    if (/modlog|mod-log|moderation log/i.test(qLower) && /how|setup|config/i.test(qLower)) {
      return 'To configure moderation logging, use `/modlog` with your request in plain English. For example:\n`/modlog prompt: Set #staff-logs as the mod-log channel and test it`';
    }

    // 4. /diagnose comprehensive capabilities
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

    // 5. /undo capabilities & limitations
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

    // 6. Broad capabilities overview: "What can Honey Bot do?"
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

    // 7. Ambiguous questions
    if (/^(?:how\s+do\s+i\s+)?(?:delete|remove)\??$/i.test(qLower)) {
      return 'What would you like to delete or remove? You can ask:\n• `/help prompt: How do I purge messages?`\n• `/help prompt: How do I delete a channel?`\n• `/help prompt: How do I delete a role?`\n• `/help prompt: How do I remove a member\'s role?`';
    }

    // 8. Unsupported features (music, economy, leveling, hacking)
    if (/\b(?:music|play\s+song|spotify|economy|coins?|leveling|xp|ranks?|gamble|hack|exploit|bypass)\b/i.test(qLower)) {
      return 'Honey Bot does not support music playback, audio streaming, economy systems, leveling, or gambling. Honey Bot strictly adheres to security boundaries and cannot perform hacking or unauthorized exploits. It is designed for Discord server administration, moderation, and diagnostics.';
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
