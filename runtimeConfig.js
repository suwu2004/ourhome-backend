function createRuntimeConfig(supabase) {
  const missingRelation = error => ['42P01', 'PGRST205', 'PGRST202'].includes(error?.code);
  const unwrap = data => Array.isArray(data) ? (data[0] || null) : data;

  async function getBaseSettings() {
    const { data, error } = await supabase.from('settings').select('*').eq('session_id', 'global').single();
    if (error) throw error;
    return data || {};
  }

  async function getProfileSecret(id) {
    if (!id) return null;
    const { data, error } = await supabase.rpc('ourhome_get_api_profile_secret', { p_profile_id: id });
    if (error) throw error;
    return unwrap(data) || null;
  }

  async function listProfiles() {
    const { data, error } = await supabase.from('api_profiles')
      .select('id, name, base_url, selected_model, is_active, api_key_secret_id, created_at, updated_at')
      .order('is_active', { ascending: false })
      .order('updated_at', { ascending: false });
    if (error) {
      if (missingRelation(error)) return [];
      throw error;
    }
    return (data || []).map(profile => ({
      id: profile.id,
      name: profile.name,
      base_url: profile.base_url,
      selected_model: profile.selected_model,
      is_active: profile.is_active,
      has_api_key: Boolean(profile.api_key_secret_id),
      created_at: profile.created_at,
      updated_at: profile.updated_at,
    }));
  }

  async function getProfileRow(id) {
    const { data, error } = await supabase.from('api_profiles').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    return data;
  }

  async function getProfileRuntime(id) {
    const profile = await getProfileRow(id);
    if (!profile) return null;
    const apiKey = await getProfileSecret(profile.id);
    return { ...profile, api_key: apiKey, api_base_url: profile.base_url };
  }

  async function loadSettings() {
    const settings = await getBaseSettings();
    try {
      const { data: profile, error } = await supabase.from('api_profiles').select('*').eq('is_active', true).maybeSingle();
      if (error) {
        if (missingRelation(error)) return settings;
        throw error;
      }
      if (!profile) return settings;
      const apiKey = await getProfileSecret(profile.id);
      if (settings.api_key) {
        const { error: cleanupError } = await supabase.from('settings')
          .update({ api_key: null, updated_at: new Date().toISOString() })
          .eq('session_id', 'global');
        if (cleanupError) console.error('清理旧版明文 API 密钥失败:', cleanupError.message);
      }
      return {
        ...settings,
        api_key: apiKey || settings.api_key || null,
        api_base_url: profile.base_url || settings.api_base_url || null,
        selected_model: profile.selected_model || settings.selected_model || null,
        active_api_profile_id: profile.id,
        active_api_profile_name: profile.name,
      };
    } catch (error) {
      if (missingRelation(error)) return settings;
      throw error;
    }
  }

  async function saveProfile({ id = null, name, base_url, api_key, selected_model, make_active = true }) {
    const { data, error } = await supabase.rpc('ourhome_save_api_profile', {
      p_id: id,
      p_name: name,
      p_base_url: base_url,
      p_api_key: api_key ?? null,
      p_selected_model: selected_model ?? null,
      p_make_active: Boolean(make_active),
    });
    if (error) throw error;
    const profile = unwrap(data);
    return profile ? { ...profile, has_api_key: Boolean(profile.api_key_secret_id), api_key_secret_id: undefined } : null;
  }

  async function activateProfile(id) {
    const { data, error } = await supabase.rpc('ourhome_activate_api_profile', { p_id: id });
    if (error) throw error;
    const profile = unwrap(data);
    return profile ? { ...profile, has_api_key: Boolean(profile.api_key_secret_id), api_key_secret_id: undefined } : null;
  }

  async function deleteProfile(id) {
    const { error } = await supabase.rpc('ourhome_delete_api_profile', { p_id: id });
    if (error) throw error;
  }

  async function updateActiveModel(model) {
    const { data: profile, error } = await supabase.from('api_profiles').select('id').eq('is_active', true).maybeSingle();
    if (error && !missingRelation(error)) throw error;
    if (profile) {
      const { error: updateError } = await supabase.from('api_profiles')
        .update({ selected_model: model, updated_at: new Date().toISOString() })
        .eq('id', profile.id);
      if (updateError) throw updateError;
    }
    const { error: settingsError } = await supabase.from('settings')
      .update({ selected_model: model, updated_at: new Date().toISOString() })
      .eq('session_id', 'global');
    if (settingsError) throw settingsError;
  }

  async function listConnections() {
    const { data, error } = await supabase.from('service_connections')
      .select('id, kind, name, url, enabled, config, secret_id, created_at, updated_at')
      .order('kind')
      .order('updated_at', { ascending: false });
    if (error) {
      if (missingRelation(error)) return [];
      throw error;
    }
    return (data || []).map(connection => ({
      id: connection.id,
      kind: connection.kind,
      name: connection.name,
      url: connection.url,
      enabled: connection.enabled,
      config: connection.config || {},
      has_secret: Boolean(connection.secret_id),
      created_at: connection.created_at,
      updated_at: connection.updated_at,
    }));
  }

  async function getConnectionRow(id) {
    const { data, error } = await supabase.from('service_connections').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    return data;
  }

  async function getConnectionSecret(id) {
    const { data, error } = await supabase.rpc('ourhome_get_service_secret', { p_connection_id: id });
    if (error) throw error;
    return unwrap(data) || null;
  }

  async function getConnectionRuntime(id) {
    const connection = await getConnectionRow(id);
    if (!connection) return null;
    return { ...connection, secret: await getConnectionSecret(connection.id) };
  }

  async function listEnabledConnectionRuntimes() {
    const { data, error } = await supabase.from('service_connections').select('*').eq('enabled', true).order('kind');
    if (error) {
      if (missingRelation(error)) return [];
      throw error;
    }
    const rows = data || [];
    return Promise.all(rows.map(async connection => ({ ...connection, secret: await getConnectionSecret(connection.id) })));
  }

  async function saveConnection({ id = null, kind, name, url, secret, enabled = true, config = {} }) {
    const { data, error } = await supabase.rpc('ourhome_save_service_connection', {
      p_id: id,
      p_kind: kind,
      p_name: name,
      p_url: url,
      p_secret: secret ?? null,
      p_enabled: Boolean(enabled),
      p_config: config || {},
    });
    if (error) throw error;
    const connection = unwrap(data);
    return connection ? { ...connection, has_secret: Boolean(connection.secret_id), secret_id: undefined } : null;
  }

  async function deleteConnection(id) {
    const { error } = await supabase.rpc('ourhome_delete_service_connection', { p_id: id });
    if (error) throw error;
  }

  return {
    getBaseSettings,
    loadSettings,
    listProfiles,
    getProfileRuntime,
    saveProfile,
    activateProfile,
    deleteProfile,
    updateActiveModel,
    listConnections,
    getConnectionRuntime,
    listEnabledConnectionRuntimes,
    saveConnection,
    deleteConnection,
  };
}

module.exports = { createRuntimeConfig };
