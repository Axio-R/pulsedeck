<script setup>
import { computed, inject, onMounted, reactive, ref, watch } from 'vue';
import { darkTheme } from 'naive-ui';

const messageFactory = inject('messageApi', null);
const token = ref(localStorage.getItem('pulsedeck-token') || '');
const activeView = ref('dashboard');
const loading = ref(false);
const error = ref('');
const dashboard = ref(null);
const nodes = ref([]);
const profiles = ref([]);
const commands = ref([]);
const channels = reactive({
  telegram: { enabled: false, botToken: '', chatId: '', parseMode: 'HTML' },
  email: { enabled: false, smtpHost: '', smtpPort: 587, username: '', password: '', from: '', to: '' }
});
const loginForm = reactive({ username: 'admin', password: 'change-me' });
const nodeForm = reactive({ name: '', region: '', tags: '' });
const profileForm = reactive({ name: '', format: 'raw', description: '' });

const menuOptions = [
  { label: '工作台', key: 'dashboard' },
  { label: '节点探针', key: 'nodes' },
  { label: '订阅分发', key: 'subscriptions' },
  { label: '通知告警', key: 'alerts' },
  { label: '命令队列', key: 'commands' },
  { label: '系统设置', key: 'settings' }
];

const currentTitle = computed(() => menuOptions.find((item) => item.key === activeView.value)?.label || 'PulseDeck');
const hasNodes = computed(() => nodes.value.length > 0);

function notify(type, text) {
  const api = messageFactory?.();
  if (api?.[type]) api[type](text);
  else if (type === 'error') console.error(text);
}

async function api(path, options = {}) {
  const headers = {
    ...(options.body ? { 'content-type': 'application/json' } : {}),
    ...(token.value ? { authorization: `Bearer ${token.value}` } : {}),
    ...(options.headers || {})
  };
  const res = await fetch(path, {
    ...options,
    headers,
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body
  });
  const contentType = res.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(body.detail || body || `HTTP ${res.status}`);
  return body;
}

async function login() {
  loading.value = true;
  error.value = '';
  try {
    const session = await api('/api/v1/auth/login', { method: 'POST', body: loginForm });
    token.value = session.token;
    localStorage.setItem('pulsedeck-token', session.token);
    await loadCurrent();
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

function logout() {
  token.value = '';
  localStorage.removeItem('pulsedeck-token');
}

async function loadCurrent() {
  if (!token.value) return;
  loading.value = true;
  error.value = '';
  try {
    if (activeView.value === 'dashboard') dashboard.value = await api('/api/v1/dashboard');
    if (activeView.value === 'nodes') nodes.value = (await api('/api/v1/nodes')).items;
    if (activeView.value === 'subscriptions') profiles.value = (await api('/api/v1/subscription-profiles')).items;
    if (activeView.value === 'alerts') Object.assign(channels, await api('/api/v1/notification-channels'));
    if (activeView.value === 'commands') commands.value = (await api('/api/v1/commands')).items;
    if (activeView.value === 'settings') {
      dashboard.value = await api('/api/v1/dashboard');
      Object.assign(channels, await api('/api/v1/notification-channels'));
    }
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

async function ensureNodesLoaded() {
  if (nodes.value.length === 0) nodes.value = (await api('/api/v1/nodes')).items;
}

async function createNode() {
  const body = {
    name: nodeForm.name || '新节点',
    region: nodeForm.region,
    tags: nodeForm.tags.split(',').map((tag) => tag.trim()).filter(Boolean)
  };
  const node = await api('/api/v1/nodes', { method: 'POST', body });
  nodes.value.unshift(node);
  Object.assign(nodeForm, { name: '', region: '', tags: '' });
  notify('success', '节点已创建');
}

async function queueCommand(node, type) {
  await api(`/api/v1/nodes/${node.id}/commands`, { method: 'POST', body: { type } });
  notify('success', '命令已加入队列');
}

async function copyText(text) {
  await navigator.clipboard.writeText(text);
  notify('success', '已复制');
}

async function loadProfiles() {
  profiles.value = (await api('/api/v1/subscription-profiles')).items;
}

async function createProfile() {
  const profile = await api('/api/v1/subscription-profiles', {
    method: 'POST',
    body: { ...profileForm }
  });
  profiles.value.unshift(profile);
  Object.assign(profileForm, { name: '', format: 'raw', description: '' });
  notify('success', '订阅已创建');
}

async function updateProfile(profile, patch) {
  const next = await api(`/api/v1/subscription-profiles/${profile.id}`, { method: 'PATCH', body: patch });
  profiles.value = profiles.value.map((item) => (item.id === profile.id ? next : item));
}

async function deleteProfile(profile) {
  await api(`/api/v1/subscription-profiles/${profile.id}`, { method: 'DELETE' });
  profiles.value = profiles.value.filter((item) => item.id !== profile.id);
  notify('success', '订阅已删除');
}

async function saveChannels() {
  Object.assign(channels, await api('/api/v1/notification-channels', { method: 'PATCH', body: channels }));
  notify('success', '告警通道已保存');
}

function nodeStateType(node) {
  if (node.online) return 'success';
  if (node.agentStatus === 'not-installed') return 'warning';
  return 'error';
}

const nodeColumns = [
  { title: '节点', key: 'name', minWidth: 160 },
  { title: '区域', key: 'region', minWidth: 110 },
  {
    title: '状态',
    key: 'status',
    width: 110,
    render(row) {
      return row.online ? '在线' : row.agentStatus === 'not-installed' ? '待安装' : '离线';
    }
  },
  {
    title: 'CPU',
    key: 'cpu',
    width: 90,
    render(row) {
      return row.metrics?.cpu?.usagePercent == null ? '-' : `${row.metrics.cpu.usagePercent}%`;
    }
  },
  {
    title: '内存',
    key: 'memory',
    width: 90,
    render(row) {
      return row.metrics?.memory?.usagePercent == null ? '-' : `${row.metrics.memory.usagePercent}%`;
    }
  },
  { title: '最后上报', key: 'lastSeenAt', minWidth: 180 }
];

watch(activeView, loadCurrent);
onMounted(loadCurrent);
</script>

<template>
  <n-config-provider :theme="darkTheme">
    <div v-if="!token" class="login-screen">
      <n-card class="login-panel" title="PulseDeck">
        <n-form>
          <n-form-item label="账号">
            <n-input v-model:value="loginForm.username" />
          </n-form-item>
          <n-form-item label="密码">
            <n-input v-model:value="loginForm.password" type="password" />
          </n-form-item>
          <n-button type="primary" block :loading="loading" @click="login">登录</n-button>
          <p v-if="error" class="error-line">{{ error }}</p>
        </n-form>
      </n-card>
    </div>

    <n-layout v-else has-sider class="app-shell">
      <n-layout-sider bordered :width="232" class="side">
        <div class="brand">
          <div class="brand-mark">P</div>
          <div>
            <strong>PulseDeck</strong>
            <span>探针式节点面板</span>
          </div>
        </div>
        <n-menu v-model:value="activeView" :options="menuOptions" />
      </n-layout-sider>

      <n-layout>
        <n-layout-header bordered class="topbar">
          <div>
            <h1>{{ currentTitle }}</h1>
            <p>端口 14770 · SoybeanAdmin 风格重构首版</p>
          </div>
          <n-space>
            <n-button secondary @click="loadCurrent" :loading="loading">刷新</n-button>
            <n-button quaternary @click="logout">退出</n-button>
          </n-space>
        </n-layout-header>

        <n-layout-content class="content">
          <p v-if="error" class="error-line">{{ error }}</p>

          <section v-if="activeView === 'dashboard'" class="view-stack">
            <n-grid :cols="4" :x-gap="12" :y-gap="12" responsive="screen">
              <n-gi>
                <n-card><n-statistic label="节点总数" :value="dashboard?.counts.nodes ?? 0" /></n-card>
              </n-gi>
              <n-gi>
                <n-card><n-statistic label="在线节点" :value="dashboard?.counts.onlineNodes ?? 0" /></n-card>
              </n-gi>
              <n-gi>
                <n-card><n-statistic label="待处理命令" :value="dashboard?.counts.queuedCommands ?? 0" /></n-card>
              </n-gi>
              <n-gi>
                <n-card><n-statistic label="启用订阅" :value="dashboard?.counts.enabledSubscriptions ?? 0" /></n-card>
              </n-gi>
            </n-grid>

            <n-grid :cols="2" :x-gap="12" :y-gap="12" responsive="screen">
              <n-gi>
                <n-card title="最近节点">
                  <n-empty v-if="!dashboard?.recentNodes?.length" description="暂无节点" />
                  <div v-for="node in dashboard?.recentNodes || []" :key="node.id" class="list-row">
                    <span>{{ node.name }}</span>
                    <n-tag :type="node.lastSeenAt ? 'success' : 'warning'" size="small">{{ node.agentStatus }}</n-tag>
                  </div>
                </n-card>
              </n-gi>
              <n-gi>
                <n-card title="命令动态">
                  <n-empty v-if="!dashboard?.recentCommands?.length" description="暂无命令" />
                  <div v-for="command in dashboard?.recentCommands || []" :key="command.id" class="list-row">
                    <span>{{ command.type }}</span>
                    <n-tag size="small">{{ command.status }}</n-tag>
                  </div>
                </n-card>
              </n-gi>
            </n-grid>
          </section>

          <section v-if="activeView === 'nodes'" class="view-stack">
            <n-card title="新建节点">
              <n-grid :cols="4" :x-gap="10" :y-gap="10" responsive="screen">
                <n-gi><n-input v-model:value="nodeForm.name" placeholder="节点名称" /></n-gi>
                <n-gi><n-input v-model:value="nodeForm.region" placeholder="区域，如 HK / JP / US" /></n-gi>
                <n-gi><n-input v-model:value="nodeForm.tags" placeholder="标签，逗号分隔" /></n-gi>
                <n-gi><n-button type="primary" block @click="createNode">创建</n-button></n-gi>
              </n-grid>
            </n-card>

            <n-card title="节点探针">
              <n-data-table :columns="nodeColumns" :data="nodes" :bordered="false" />
              <n-empty v-if="!hasNodes" description="创建节点后复制安装命令到 VPS 执行" />
            </n-card>

            <n-grid :cols="2" :x-gap="12" :y-gap="12" responsive="screen">
              <n-gi v-for="node in nodes" :key="node.id">
                <n-card>
                  <template #header>
                    <div class="card-title">
                      <span>{{ node.name }}</span>
                      <n-tag :type="nodeStateType(node)" size="small">{{ node.online ? '在线' : node.agentStatus }}</n-tag>
                    </div>
                  </template>
                  <n-descriptions :column="2" size="small">
                    <n-descriptions-item label="区域">{{ node.region || '-' }}</n-descriptions-item>
                    <n-descriptions-item label="地址">{{ node.addresses?.length || 0 }}</n-descriptions-item>
                    <n-descriptions-item label="CPU">{{ node.metrics?.cpu?.usagePercent ?? '-' }}%</n-descriptions-item>
                    <n-descriptions-item label="内存">{{ node.metrics?.memory?.usagePercent ?? '-' }}%</n-descriptions-item>
                  </n-descriptions>
                  <n-divider />
                  <n-input :value="node.installCommand" readonly type="textarea" :autosize="{ minRows: 2, maxRows: 4 }" />
                  <n-space class="actions">
                    <n-button size="small" @click="copyText(node.installCommand)">复制安装</n-button>
                    <n-button size="small" @click="queueCommand(node, 'probe')">探测</n-button>
                    <n-button size="small" @click="queueCommand(node, 'diagnostics')">诊断</n-button>
                  </n-space>
                </n-card>
              </n-gi>
            </n-grid>
          </section>

          <section v-if="activeView === 'subscriptions'" class="view-stack">
            <n-card title="新建订阅">
              <n-grid :cols="4" :x-gap="10" :y-gap="10" responsive="screen">
                <n-gi><n-input v-model:value="profileForm.name" placeholder="订阅名称" /></n-gi>
                <n-gi>
                  <n-select v-model:value="profileForm.format" :options="[
                    { label: 'Raw', value: 'raw' },
                    { label: 'Clash', value: 'clash' },
                    { label: 'V2Ray', value: 'v2ray' }
                  ]" />
                </n-gi>
                <n-gi><n-input v-model:value="profileForm.description" placeholder="备注" /></n-gi>
                <n-gi><n-button type="primary" block @click="createProfile">创建</n-button></n-gi>
              </n-grid>
            </n-card>

            <n-grid :cols="3" :x-gap="12" :y-gap="12" responsive="screen">
              <n-gi v-for="profile in profiles" :key="profile.id">
                <n-card>
                  <template #header>
                    <div class="card-title">
                      <span>{{ profile.name }}</span>
                      <n-tag size="small">{{ profile.format }}</n-tag>
                    </div>
                  </template>
                  <n-thing :description="profile.description || '订阅 URL'">
                    <n-input :value="profile.publicUrl" readonly />
                  </n-thing>
                  <n-space class="actions">
                    <n-button size="small" @click="copyText(profile.publicUrl)">复制</n-button>
                    <n-button size="small" tag="a" :href="profile.publicUrl" target="_blank">打开</n-button>
                    <n-switch :value="profile.enabled" @update:value="(value) => updateProfile(profile, { enabled: value })" />
                    <n-popconfirm v-if="profile.deletable" @positive-click="deleteProfile(profile)">
                      <template #trigger><n-button size="small" type="error" secondary>删除</n-button></template>
                      删除这个订阅 URL？
                    </n-popconfirm>
                  </n-space>
                </n-card>
              </n-gi>
            </n-grid>
          </section>

          <section v-if="activeView === 'alerts'" class="view-stack">
            <n-grid :cols="2" :x-gap="12" :y-gap="12" responsive="screen">
              <n-gi>
                <n-card title="Telegram">
                  <n-form>
                    <n-form-item label="启用"><n-switch v-model:value="channels.telegram.enabled" /></n-form-item>
                    <n-form-item label="Bot Token"><n-input v-model:value="channels.telegram.botToken" type="password" /></n-form-item>
                    <n-form-item label="Chat ID"><n-input v-model:value="channels.telegram.chatId" /></n-form-item>
                  </n-form>
                </n-card>
              </n-gi>
              <n-gi>
                <n-card title="邮箱">
                  <n-form>
                    <n-form-item label="启用"><n-switch v-model:value="channels.email.enabled" /></n-form-item>
                    <n-form-item label="SMTP"><n-input v-model:value="channels.email.smtpHost" /></n-form-item>
                    <n-form-item label="端口"><n-input-number v-model:value="channels.email.smtpPort" /></n-form-item>
                    <n-form-item label="收件人"><n-input v-model:value="channels.email.to" /></n-form-item>
                  </n-form>
                </n-card>
              </n-gi>
            </n-grid>
            <n-button type="primary" @click="saveChannels">保存告警通道</n-button>
          </section>

          <section v-if="activeView === 'commands'" class="view-stack">
            <n-card title="命令队列">
              <div v-for="command in commands" :key="command.id" class="list-row">
                <span>{{ command.type }}</span>
                <n-space>
                  <n-tag size="small">{{ command.status }}</n-tag>
                  <span class="muted">{{ command.updatedAt }}</span>
                </n-space>
              </div>
              <n-empty v-if="!commands.length" description="暂无命令" />
            </n-card>
          </section>

          <section v-if="activeView === 'settings'" class="view-stack">
            <n-card title="系统信息">
              <n-descriptions :column="2">
                <n-descriptions-item label="默认端口">14770</n-descriptions-item>
                <n-descriptions-item label="镜像">ghcr.io/axio-r/pulsedeck:latest</n-descriptions-item>
                <n-descriptions-item label="节点总数">{{ dashboard?.counts.nodes ?? 0 }}</n-descriptions-item>
                <n-descriptions-item label="告警方式">Telegram / 邮箱</n-descriptions-item>
              </n-descriptions>
            </n-card>
          </section>
        </n-layout-content>
      </n-layout>
    </n-layout>
  </n-config-provider>
</template>
