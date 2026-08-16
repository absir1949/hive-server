'use strict';

async function postJson(fetchImpl, endpoint, body) {
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }
  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

/**
 * Load the Profile URL in a managed background window and always close it.
 * The Page API waits for the load event, so no foreground navigation is needed.
 */
async function keepAliveInBackground({ baseUrl, profileId, url, fetchImpl = globalThis.fetch }) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');

  const root = String(baseUrl).replace(/\/$/, '');
  const id = encodeURIComponent(String(profileId));
  const created = await postJson(
    fetchImpl,
    `${root}/browsers/${id}/pages/new`,
    { url },
  );
  if (!created.pageId) throw new Error('Background keep-alive page did not return pageId');

  const pageId = encodeURIComponent(String(created.pageId));
  try {
    return { pageId: created.pageId };
  } finally {
    await postJson(
      fetchImpl,
      `${root}/browsers/${id}/pages/${pageId}/close`,
      {},
    );
  }
}

/**
 * Keep-alive is an activity policy, not a lifecycle owner. It is allowed to
 * touch only a Profile whose browser is already confirmed running.
 */
async function keepAliveRunningProfile({ containerManager, baseUrl, profile, fetchImpl = globalThis.fetch }) {
  const profileId = String(profile.id);
  if (!containerManager.containers.has(profileId)) return { ran: false };

  const status = await containerManager.status(profileId);
  if (status !== 'running') return { ran: false };

  await keepAliveInBackground({
    baseUrl,
    profileId,
    url: profile.url,
    fetchImpl,
  });
  return { ran: true };
}

module.exports = { keepAliveInBackground, keepAliveRunningProfile };
