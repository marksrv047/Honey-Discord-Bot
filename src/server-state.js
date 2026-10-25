import { ChannelType } from 'discord.js';

/**
 * Strips potential prompt-injection patterns from server text fields.
 */
function sanitizeServerText(text) {
  if (!text) return '';
  return String(text)
    .replace(/System\s*Prompt/gi, '[Filtered]')
    .replace(/Ignore\s*previous\s*instructions/gi, '[Filtered]')
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '') // Remove non-printable control chars
    .substring(0, 100);
}

/**
 * Generates a clean, compact snapshot of the Discord guild state.
 * Feeds essential context to the AI Planner without bloating tokens or leaking private data.
 */
export async function getGuildStateSnapshot(guild) {
  // Fetch fresh caches
  await guild.roles.fetch();
  await guild.channels.fetch();

  // 1. Roles summary (ordered by hierarchy position descending)
  const roles = guild.roles.cache
    .filter(r => r.id !== guild.id) // Exclude @everyone from the main list
    .sort((a, b) => b.position - a.position)
    .map(r => ({
      id: r.id,
      name: sanitizeServerText(r.name),
      color: r.hexColor,
      position: r.position,
      hoist: r.hoist,
      isAdmin: r.permissions.has('Administrator'),
      managed: r.managed
    }))
    .slice(0, 35); // Keep top 35 roles to stay token efficient

  // 2. Categories & Channels
  const categories = guild.channels.cache
    .filter(c => c.type === ChannelType.GuildCategory)
    .sort((a, b) => a.position - b.position)
    .map(cat => ({
      id: cat.id,
      name: sanitizeServerText(cat.name),
      position: cat.position
    }));

  const channels = guild.channels.cache
    .filter(c => c.type !== ChannelType.GuildCategory)
    .sort((a, b) => a.position - b.position)
    .map(c => {
      let typeStr = 'TEXT';
      if (c.type === ChannelType.GuildVoice) typeStr = 'VOICE';
      if (c.type === ChannelType.GuildAnnouncement) typeStr = 'ANNOUNCEMENT';
      if (c.type === ChannelType.GuildStageVoice) typeStr = 'STAGE';

      return {
        id: c.id,
        name: sanitizeServerText(c.name),
        type: typeStr,
        category: c.parent ? sanitizeServerText(c.parent.name) : null,
        isPrivate: !c.permissionsFor(guild.roles.everyone)?.has('ViewChannel')
      };
    })
    .slice(0, 50); // Keep top 50 channels

  // 3. Guild Boost Tier
  // 0 = None, 1 = Tier 1 (2 boosts), 2 = Tier 2 (7 boosts), 3 = Tier 3 (14 boosts)
  const boostTier = guild.premiumTier;

  return {
    guild: {
      id: guild.id,
      name: sanitizeServerText(guild.name),
      memberCount: guild.memberCount,
      boostTier,
      hasBannerSupport: boostTier >= 2,
      ownerId: guild.ownerId,
    },
    roles,
    categories,
    channels
  };
}
