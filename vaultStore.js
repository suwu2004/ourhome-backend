const MAX_GROUPS = 100;
const MAX_ACCOUNTS_PER_GROUP = 200;
const MAX_TRANSACTIONS = 5000;
const MAX_GOALS = 200;

function cleanText(value, fallback = '', max = 200) {
  const text = String(value ?? '').trim();
  return (text || fallback).slice(0, max);
}

function requireText(value, label, max = 200) {
  const text = cleanText(value, '', max);
  if (!text) throw new Error(`${label}不能为空`);
  return text;
}

function finiteNumber(value, label, { min = -Infinity, max = Infinity } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(`${label}不正确`);
  }
  return number;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function shanghaiDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function shanghaiMonth() {
  return shanghaiDate().slice(0, 7);
}

function assertDate(value) {
  const date = cleanText(value || shanghaiDate(), shanghaiDate(), 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new Error('日期格式应为 YYYY-MM-DD');
  }
  return date;
}

function normalizeImportedState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('金库数据格式不正确');
  const groups = Array.isArray(raw.accountGroups) ? raw.accountGroups.slice(0, MAX_GROUPS) : [];
  const seenIds = new Set();
  const accountGroups = groups.map((group, groupIndex) => ({
    id: cleanText(group?.id, `group-${groupIndex}`, 128),
    name: requireText(group?.name, '账户分组名称', 80),
    emoji: cleanText(group?.emoji, '💳', 16),
    sortOrder: groupIndex,
    accounts: (Array.isArray(group?.accounts) ? group.accounts : []).slice(0, MAX_ACCOUNTS_PER_GROUP).map((account, accountIndex) => {
      let id = cleanText(account?.id, `account-${groupIndex}-${accountIndex}`, 128);
      if (seenIds.has(id)) id = `${id}-${groupIndex}-${accountIndex}`.slice(0, 128);
      seenIds.add(id);
      return {
        id,
        name: requireText(account?.name, '账户名称', 80),
        type: account?.type === 'debt' ? 'debt' : 'asset',
        balance: finiteNumber(account?.balance ?? 0, '账户余额', { min: -1e12, max: 1e12 }),
        emoji: cleanText(account?.emoji, '💳', 16),
        sortOrder: accountIndex,
      };
    }),
  }));

  const transactions = (Array.isArray(raw.transactions) ? raw.transactions : []).slice(0, MAX_TRANSACTIONS).map(transaction => ({
    date: assertDate(transaction?.date),
    type: transaction?.type === 'income' ? 'income' : 'expense',
    amount: finiteNumber(transaction?.amount, '流水金额', { min: 0.01, max: 1e12 }),
    category: cleanText(transaction?.category, '其他', 80),
    accountId: cleanText(transaction?.accountId, '', 128),
    tag: cleanText(transaction?.tag, '', 40),
    note: cleanText(transaction?.note, '', 500),
  }));

  const goals = (Array.isArray(raw.goals) ? raw.goals : []).slice(0, MAX_GOALS).map(goal => ({
    name: requireText(goal?.name, '存钱目标名称', 100),
    emoji: cleanText(goal?.emoji, '🎯', 16),
    target: finiteNumber(goal?.target, '目标金额', { min: 0.01, max: 1e12 }),
    current: finiteNumber(goal?.current ?? 0, '已存金额', { min: 0, max: 1e12 }),
  }));

  return {
    version: 2,
    accountGroups,
    transactions,
    goals,
    budget: finiteNumber(raw.budget ?? 0, '本月预算', { min: 0, max: 1e12 }),
  };
}

function unwrap(result, fallback = '金库操作失败') {
  if (result.error) throw new Error(result.error.message || fallback);
  return result.data;
}

function createVaultStore(supabase) {
  async function getSyncState() {
    const result = await supabase.from('vault_sync_state').select('*').eq('id', 'global').maybeSingle();
    return unwrap(result) || { id: 'global', initialized: false };
  }

  async function assertInitialized() {
    const sync = await getSyncState();
    if (!sync.initialized) {
      throw new Error('请先打开一次猫の金库，让手机里的账本完成云端同步');
    }
  }

  async function markInitialized() {
    unwrap(await supabase.from('vault_sync_state').upsert({
      id: 'global', initialized: true, updated_at: new Date().toISOString(),
    }, { onConflict: 'id' }));
  }

  async function getState() {
    const month = shanghaiMonth();
    const [groupsResult, accountsResult, transactionsResult, budgetResult, goalsResult, categoriesResult, syncResult] = await Promise.all([
      supabase.from('vault_account_groups').select('*').order('sort_order').order('created_at'),
      supabase.from('vault_accounts').select('*').order('sort_order').order('created_at'),
      supabase.from('vault_transactions').select('*').order('date', { ascending: false }).order('created_at', { ascending: false }).limit(MAX_TRANSACTIONS),
      supabase.from('vault_budgets').select('*').eq('month', month).maybeSingle(),
      supabase.from('vault_savings_goals').select('*').order('created_at'),
      supabase.from('vault_categories').select('name,type,emoji,sort_order').order('type').order('sort_order'),
      supabase.from('vault_sync_state').select('*').eq('id', 'global').maybeSingle(),
    ]);

    const groups = unwrap(groupsResult);
    const accounts = unwrap(accountsResult);
    const transactions = unwrap(transactionsResult);
    const budget = unwrap(budgetResult);
    const goals = unwrap(goalsResult);
    const categories = unwrap(categoriesResult);
    const sync = unwrap(syncResult) || { initialized: false };

    const groupMap = new Map((groups || []).map(group => [group.id, {
      id: group.id,
      name: group.name,
      emoji: group.emoji || '💳',
      accounts: [],
    }]));
    for (const account of accounts || []) {
      const group = groupMap.get(account.group_id);
      if (!group) continue;
      group.accounts.push({
        id: account.id,
        name: account.name,
        type: account.is_debt || account.type === 'debt' ? 'debt' : 'asset',
        balance: Number(account.balance || 0),
        emoji: account.emoji || '💳',
      });
    }

    return {
      version: 2,
      accountGroups: [...groupMap.values()],
      transactions: (transactions || []).map(transaction => ({
        id: transaction.id,
        date: transaction.date,
        type: transaction.type,
        amount: Number(transaction.amount || 0),
        category: transaction.category_name || '其他',
        accountId: transaction.account_id,
        accountName: transaction.account_name_snapshot || null,
        groupName: transaction.group_name_snapshot || null,
        tag: transaction.tag || '',
        note: transaction.note || '',
        source: transaction.source || 'manual',
        createdAt: transaction.created_at,
      })),
      goals: (goals || []).map(goal => ({
        id: goal.id,
        name: goal.name,
        target: Number(goal.target_amount || 0),
        current: Number(goal.current_amount || 0),
        emoji: goal.emoji || '🎯',
      })),
      budget: Number(budget?.amount || 0),
      categories: (categories || []).map(category => ({
        name: category.name, type: category.type, emoji: category.emoji,
      })),
      needsImport: !sync.initialized,
      syncedAt: sync.updated_at || null,
    };
  }

  async function importState(raw) {
    const sync = await getSyncState();
    if (sync.initialized) return { imported: false, state: await getState() };
    const state = normalizeImportedState(raw);
    unwrap(await supabase.rpc('ourhome_vault_replace_state', { p_state: state }));
    return { imported: true, state: await getState() };
  }

  async function findGroup({ groupId, groupName }) {
    if (groupId) {
      if (!isUuid(groupId)) throw new Error('账户分组编号不正确');
      const group = unwrap(await supabase.from('vault_account_groups').select('*').eq('id', groupId).maybeSingle());
      if (!group) throw new Error('找不到这个账户分组');
      return group;
    }
    const name = requireText(groupName, '账户分组名称', 80);
    const groups = unwrap(await supabase.from('vault_account_groups').select('*').eq('name', name).limit(2));
    if (!groups?.length) throw new Error(`找不到账户分组“${name}”`);
    if (groups.length > 1) throw new Error(`有多个名为“${name}”的分组，请先读取金库并使用分组编号`);
    return groups[0];
  }

  async function findAccount({ accountId, accountName, groupName }) {
    if (accountId) {
      if (!isUuid(accountId)) throw new Error('账户编号不正确');
      const account = unwrap(await supabase.from('vault_accounts').select('*').eq('id', accountId).maybeSingle());
      if (!account) throw new Error('找不到这个账户');
      return account;
    }
    const name = requireText(accountName, '账户名称', 80);
    let query = supabase.from('vault_accounts').select('*').eq('name', name);
    if (groupName) {
      const group = await findGroup({ groupName });
      query = query.eq('group_id', group.id);
    }
    const accounts = unwrap(await query.limit(2));
    if (!accounts?.length) throw new Error(`找不到账户“${name}”`);
    if (accounts.length > 1) throw new Error(`有多个名为“${name}”的账户，请补充分组名称或使用账户编号`);
    return accounts[0];
  }

  async function findGoal({ goalId, goalName }) {
    if (goalId) {
      if (!isUuid(goalId)) throw new Error('目标编号不正确');
      const goal = unwrap(await supabase.from('vault_savings_goals').select('*').eq('id', goalId).maybeSingle());
      if (!goal) throw new Error('找不到这个存钱目标');
      return goal;
    }
    const name = requireText(goalName, '存钱目标名称', 100);
    const goals = unwrap(await supabase.from('vault_savings_goals').select('*').eq('name', name).limit(2));
    if (!goals?.length) throw new Error(`找不到存钱目标“${name}”`);
    if (goals.length > 1) throw new Error(`有多个名为“${name}”的目标，请先读取金库并使用目标编号`);
    return goals[0];
  }

  async function addTransaction(input, source = 'assistant') {
    await assertInitialized();
    const account = await findAccount(input);
    const type = input.type === 'income' ? 'income' : input.type === 'expense' ? 'expense' : null;
    if (!type) throw new Error('请选择收入或支出');
    const amount = finiteNumber(input.amount, '金额', { min: 0.01, max: 1e12 });
    const date = assertDate(input.date);
    const categoryName = cleanText(input.category, '其他', 80);
    const id = unwrap(await supabase.rpc('ourhome_vault_create_transaction', {
      p_date: date,
      p_type: type,
      p_amount: amount,
      p_category_name: categoryName,
      p_account_id: account.id,
      p_tag: cleanText(input.tag, '', 40),
      p_note: cleanText(input.note, '', 500),
      p_source: cleanText(source, 'assistant', 40),
    }));
    return { id, accountId: account.id, accountName: account.name, type, amount, date, category: categoryName };
  }

  async function deleteTransaction(input) {
    await assertInitialized();
    const id = input.transactionId || input.id;
    if (!isUuid(id)) throw new Error('流水编号不正确，请先读取金库取得编号');
    const deleted = unwrap(await supabase.rpc('ourhome_vault_delete_transaction', { p_transaction_id: id }));
    if (!deleted) throw new Error('找不到这笔流水');
    return { id, deleted: true };
  }

  async function manageAccounts(input) {
    await assertInitialized();
    const action = cleanText(input.action, '', 40);
    let result;
    if (action === 'create_group') {
      const groups = unwrap(await supabase.from('vault_account_groups').select('id')) || [];
      result = unwrap(await supabase.from('vault_account_groups').insert({
        name: requireText(input.name, '分组名称', 80),
        emoji: cleanText(input.emoji, '💳', 16),
        sort_order: groups.length,
      }).select().single());
    } else if (action === 'update_group') {
      const group = await findGroup(input);
      const updates = { updated_at: new Date().toISOString() };
      if (input.name !== undefined) updates.name = requireText(input.name, '分组名称', 80);
      if (input.emoji !== undefined) updates.emoji = cleanText(input.emoji, '💳', 16);
      result = unwrap(await supabase.from('vault_account_groups').update(updates).eq('id', group.id).select().single());
    } else if (action === 'delete_group') {
      const group = await findGroup(input);
      unwrap(await supabase.from('vault_account_groups').delete().eq('id', group.id));
      result = { id: group.id, name: group.name, deleted: true };
    } else if (action === 'create_account') {
      const group = await findGroup(input);
      const type = input.type === 'debt' ? 'debt' : 'asset';
      const siblings = unwrap(await supabase.from('vault_accounts').select('id').eq('group_id', group.id)) || [];
      result = unwrap(await supabase.from('vault_accounts').insert({
        group_id: group.id,
        name: requireText(input.name, '账户名称', 80),
        type,
        is_debt: type === 'debt',
        balance: finiteNumber(input.balance ?? 0, '账户余额', { min: -1e12, max: 1e12 }),
        emoji: cleanText(input.emoji, '💳', 16),
        sort_order: siblings.length,
        updated_at: new Date().toISOString(),
      }).select().single());
    } else if (action === 'update_account') {
      const account = await findAccount(input);
      const updates = { updated_at: new Date().toISOString() };
      if (input.name !== undefined) updates.name = requireText(input.name, '账户名称', 80);
      if (input.emoji !== undefined) updates.emoji = cleanText(input.emoji, '💳', 16);
      if (input.balance !== undefined) updates.balance = finiteNumber(input.balance, '账户余额', { min: -1e12, max: 1e12 });
      if (input.type !== undefined) {
        updates.type = input.type === 'debt' ? 'debt' : 'asset';
        updates.is_debt = updates.type === 'debt';
      }
      if (input.targetGroupId || input.targetGroupName) {
        const target = await findGroup({ groupId: input.targetGroupId, groupName: input.targetGroupName });
        updates.group_id = target.id;
      }
      result = unwrap(await supabase.from('vault_accounts').update(updates).eq('id', account.id).select().single());
    } else if (action === 'delete_account') {
      const account = await findAccount(input);
      unwrap(await supabase.from('vault_accounts').delete().eq('id', account.id));
      result = { id: account.id, name: account.name, deleted: true };
    } else {
      throw new Error('未知的账户操作');
    }
    await markInitialized();
    return result;
  }

  async function setBudget(input) {
    await assertInitialized();
    const amount = finiteNumber(input.amount, '预算金额', { min: 0, max: 1e12 });
    const month = cleanText(input.month, shanghaiMonth(), 7);
    if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('预算月份格式应为 YYYY-MM');
    const budget = unwrap(await supabase.from('vault_budgets').upsert({ month, amount }, { onConflict: 'month' }).select().single());
    await markInitialized();
    return { ...budget, amount: Number(budget.amount) };
  }

  async function manageGoal(input) {
    await assertInitialized();
    const action = cleanText(input.action, '', 20);
    let result;
    if (action === 'create') {
      result = unwrap(await supabase.from('vault_savings_goals').insert({
        name: requireText(input.name, '目标名称', 100),
        emoji: cleanText(input.emoji, '🎯', 16),
        target_amount: finiteNumber(input.target, '目标金额', { min: 0.01, max: 1e12 }),
        current_amount: finiteNumber(input.current ?? 0, '已存金额', { min: 0, max: 1e12 }),
      }).select().single());
    } else if (action === 'update') {
      const goal = await findGoal(input);
      const updates = {};
      if (input.name !== undefined) updates.name = requireText(input.name, '目标名称', 100);
      if (input.emoji !== undefined) updates.emoji = cleanText(input.emoji, '🎯', 16);
      if (input.target !== undefined) updates.target_amount = finiteNumber(input.target, '目标金额', { min: 0.01, max: 1e12 });
      if (input.current !== undefined) updates.current_amount = finiteNumber(input.current, '已存金额', { min: 0, max: 1e12 });
      if (!Object.keys(updates).length) throw new Error('没有需要修改的目标内容');
      result = unwrap(await supabase.from('vault_savings_goals').update(updates).eq('id', goal.id).select().single());
    } else if (action === 'delete') {
      const goal = await findGoal(input);
      unwrap(await supabase.from('vault_savings_goals').delete().eq('id', goal.id));
      result = { id: goal.id, name: goal.name, deleted: true };
    } else {
      throw new Error('未知的存钱目标操作');
    }
    await markInitialized();
    return result;
  }

  async function assistantSnapshot() {
    const state = await getState();
    const accounts = state.accountGroups.flatMap(group => group.accounts.map(account => ({
      groupId: group.id,
      groupName: group.name,
      accountId: account.id,
      accountName: account.name,
      type: account.type,
      balance: account.balance,
    })));
    const month = shanghaiMonth();
    const monthTransactions = state.transactions.filter(row => String(row.date).startsWith(month));
    const income = monthTransactions.filter(row => row.type === 'income').reduce((sum, row) => sum + row.amount, 0);
    const expense = monthTransactions.filter(row => row.type === 'expense').reduce((sum, row) => sum + row.amount, 0);
    return {
      initialized: !state.needsImport,
      message: state.needsImport ? '请让叶檀先打开一次猫の金库，完成手机旧账本的云端迁移。' : undefined,
      month,
      budget: state.budget,
      monthIncome: income,
      monthExpense: expense,
      accounts,
      goals: state.goals,
      recentTransactions: state.transactions.slice(0, 50),
    };
  }

  return {
    getState,
    importState,
    addTransaction,
    deleteTransaction,
    manageAccounts,
    setBudget,
    manageGoal,
    assistantSnapshot,
  };
}

module.exports = { createVaultStore, normalizeImportedState };
