export function userObjectFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    display_name: (typeof row.display_name === 'string' && row.display_name.trim()) || row.username,
    bio: row.bio || '',
    avatar_file_id: row.avatar_file_id ?? null,
    is_following: Boolean(row.is_following),
    is_follower: Boolean(row.is_follower),
    online: Boolean(row.online),
    last_seen: row.last_seen ?? null,
    email: row.email ?? null,
    google_id: row.google_id ?? null,
  };
}

export function messageObjectFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    sender_id: row.sender_id,
    client_id: row.client_id ?? null,
    type: row.type,
    text: row.text ?? null,
    attachment: row.attachment_file_id
      ? {
          file_id: row.attachment_file_id,
          name: row.attachment_name,
          size: row.attachment_size,
          mime: row.attachment_mime,
          ...(row.type === 'audio'
            ? { duration_ms: row.attachment_duration_ms ?? null }
            : {}),
          ...(row.type === 'image'
            ? {
                width: row.attachment_width ?? null,
                height: row.attachment_height ?? null,
              }
            : {}),
        }
      : null,
    sticker:
      row.type === 'sticker' && row.sticker_pack
        ? { pack: row.sticker_pack, id: row.sticker_id }
        : null,
    status: row.status,
    created_at: row.created_at,
  };
}

export function storyObjectFromRow(row, { includeViewCount = false } = {}) {
  if (!row) return null;
  const story = {
    id: row.id,
    user_id: row.user_id,
    type: row.type,
    caption: row.caption ?? null,
    text: row.text ?? null,
    bg_color: row.bg_color ?? null,
    file_id: row.file_id ?? null,
    created_at: row.created_at,
    expires_at: row.expires_at,
    seen: Boolean(row.seen),
  };
  if (includeViewCount) story.view_count = Number(row.viewer_count || 0);
  return story;
}
