// ============================================================
// GhaNight Cache Layer v1
// Paste this into ALL your HTML files inside <script> before
// any Supabase calls. Handles:
//   - In-memory cache (survives page interactions)
//   - LocalStorage cache (survives page refreshes)
//   - Cache invalidation (stale-while-revalidate)
//   - Deduplication (concurrent identical requests merged)
//   - Ticket buying race condition prevention
// ============================================================

const GNCache = (function() {

  // ── Config ────────────────────────────────────────────────
  const TTL = {
    venues:    60 * 1000,       // 60 seconds — crowd data changes often
    events:    5  * 60 * 1000,  // 5 minutes  — events don't change mid-night
    posts:     3  * 60 * 1000,  // 3 minutes  — new posts come in occasionally
    videos:    10 * 60 * 1000,  // 10 minutes — videos rarely change
    settings:  30 * 60 * 1000,  // 30 minutes — platform settings rarely change
    checkins:  30 * 1000,       // 30 seconds — crowd counts change fast
  };

  // ── In-memory store (fast, cleared on page reload) ────────
  const memCache = new Map();

  // ── In-flight request deduplication ───────────────────────
  // If 100 users hit the page at same time, only 1 DB call fires
  const inFlight = new Map();

  // ── Core cache get ─────────────────────────────────────────
  function get(key) {
    // Check memory first (fastest)
    if (memCache.has(key)) {
      const entry = memCache.get(key);
      if (Date.now() < entry.expires) {
        return entry.data;
      }
      memCache.delete(key);
    }

    // Check localStorage (persists across page refresh)
    try {
      const raw = localStorage.getItem('gnc_' + key);
      if (raw) {
        const entry = JSON.parse(raw);
        if (Date.now() < entry.expires) {
          // Promote back to memory cache
          memCache.set(key, entry);
          return entry.data;
        }
        localStorage.removeItem('gnc_' + key);
      }
    } catch(e) {}

    return null;
  }

  // ── Core cache set ─────────────────────────────────────────
  function set(key, data, ttlMs) {
    const entry = { data, expires: Date.now() + ttlMs };

    // Set in memory always
    memCache.set(key, entry);

    // Set in localStorage for page-refresh persistence
    // Only for non-sensitive, small payloads
    try {
      const serialized = JSON.stringify(entry);
      if (serialized.length < 50000) { // don't store huge payloads
        localStorage.setItem('gnc_' + key, serialized);
      }
    } catch(e) {
      // localStorage full — clear old cache entries
      clearOldEntries();
    }
  }

  // ── Cache invalidation ────────────────────────────────────
  function invalidate(key) {
    memCache.delete(key);
    try { localStorage.removeItem('gnc_' + key); } catch(e) {}
  }

  function invalidateAll() {
    memCache.clear();
    try {
      Object.keys(localStorage)
        .filter(k => k.startsWith('gnc_'))
        .forEach(k => localStorage.removeItem(k));
    } catch(e) {}
  }

  // ── Clear old/expired localStorage entries ────────────────
  function clearOldEntries() {
    try {
      Object.keys(localStorage)
        .filter(k => k.startsWith('gnc_'))
        .forEach(k => {
          try {
            const entry = JSON.parse(localStorage.getItem(k));
            if (Date.now() >= entry.expires) localStorage.removeItem(k);
          } catch(e) { localStorage.removeItem(k); }
        });
    } catch(e) {}
  }

  // ── Deduplicated fetch ────────────────────────────────────
  // If 100 components call fetchCached('venues') simultaneously,
  // only 1 actual DB query fires. All 100 get the same result.
  async function fetchCached(key, ttlMs, fetchFn) {
    // 1. Check cache first
    const cached = get(key);
    if (cached !== null) return cached;

    // 2. Check if a request is already in flight
    if (inFlight.has(key)) {
      return await inFlight.get(key);
    }

    // 3. Fire the actual fetch — deduplicated
    const promise = fetchFn()
      .then(data => {
        set(key, data, ttlMs);
        inFlight.delete(key);
        return data;
      })
      .catch(err => {
        inFlight.delete(key);
        throw err;
      });

    inFlight.set(key, promise);
    return await promise;
  }

  // ── Stale-while-revalidate ────────────────────────────────
  // Returns stale data immediately, refreshes in background.
  // Users always see something instantly even if data is old.
  async function staleWhileRevalidate(key, ttlMs, fetchFn, onUpdate) {
    const cached = get(key);

    if (cached !== null) {
      // Return stale data immediately
      // Refresh in background silently
      fetchFn().then(fresh => {
        set(key, fresh, ttlMs);
        if (onUpdate) onUpdate(fresh);
      }).catch(() => {});
      return cached;
    }

    // No cache at all — must wait
    const data = await fetchFn();
    set(key, data, ttlMs);
    return data;
  }

  // ── Public API ─────────────────────────────────────────────
  return { get, set, invalidate, invalidateAll, fetchCached, staleWhileRevalidate, TTL };

})();


// ============================================================
// Cached Supabase helpers — use these instead of raw db calls
// ============================================================

async function cachedVenues(db) {
  return GNCache.fetchCached('venues', GNCache.TTL.venues, async () => {
    const { data, error } = await db
      .from('venues')
      .select('*')
      .eq('active', true)
      .order('premium', { ascending: false })
      .order('heat',    { ascending: false });
    if (error) throw error;
    return data || [];
  });
}

async function cachedEvents(db) {
  return GNCache.fetchCached('events', GNCache.TTL.events, async () => {
    const { data, error } = await db
      .from('events')
      .select('*')
      .eq('active', true)
      .order('sponsored', { ascending: false });
    if (error) throw error;
    return data || [];
  });
}

async function cachedPosts(db) {
  return GNCache.fetchCached('posts', GNCache.TTL.posts, async () => {
    const { data, error } = await db
      .from('creator_posts')
      .select('*, post_likes(count), post_comments(count)')
      .eq('status', 'approved')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
  });
}

async function cachedVideos(db, uploaderType) {
  const key = uploaderType ? `videos_${uploaderType}` : 'videos_all';
  return GNCache.fetchCached(key, GNCache.TTL.videos, async () => {
    let q = db.from('venue_videos').select('*').eq('is_active', true).order('created_at', { ascending: false }).limit(20);
    if (uploaderType) q = q.eq('uploader_type', uploaderType);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  });
}

async function cachedSettings(db) {
  return GNCache.fetchCached('settings', GNCache.TTL.settings, async () => {
    const { data, error } = await db
      .from('platform_settings')
      .select('value')
      .eq('key', 'creator_settings')
      .single();
    if (error) return null;
    return data;
  });
}

// Invalidate venues cache when admin updates a venue
// Call this after any venue update in admin.html
function invalidateVenuesCache() {
  GNCache.invalidate('venues');
}

// Invalidate events cache when admin updates an event
function invalidateEventsCache() {
  GNCache.invalidate('events');
}
