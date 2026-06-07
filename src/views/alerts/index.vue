<script setup lang="ts">
import { computed, h, onMounted, reactive, ref } from 'vue';
import { NButton, NPopconfirm, NTag } from 'naive-ui';
import {
  ackPulseAlertEvent,
  checkPulseAlerts,
  deletePulseAlertEvent,
  fetchPulseAlertEvents,
  fetchPulseAlertPolicy,
  fetchPulseChannels,
  savePulseAlertPolicy,
  savePulseChannels,
  type PulseAlertEvent,
  type PulseAlertPolicy,
  type PulseChannels
} from '@/service/api';
import { formatBeijingTime } from '@/utils/pulse-format';

const loading = ref(false);
const saving = ref(false);
const checking = ref(false);
const events = ref<PulseAlertEvent[]>([]);
const channels = reactive<PulseChannels>({
  telegram: { enabled: false, botToken: '', chatId: '', parseMode: 'HTML' },
  email: { enabled: false, smtpHost: '', smtpPort: 587, username: '', password: '', from: '', to: '' }
});
const policy = reactive<PulseAlertPolicy>({
  offlineAfterSeconds: 180,
  offlineChannels: ['telegram', 'email'],
  trafficChannels: ['telegram', 'email'],
  autoDisableOnTrafficLimit: true,
  trafficLimitAction: 'disable-node-subscription'
});
const channelOptions = [
  { label: 'Telegram', value: 'telegram' },
  { label: '邮箱', value: 'email' }
];
const trafficActionOptions = [
  { label: '禁用节点订阅', value: 'disable-node-subscription' },
  { label: '禁用全部订阅', value: 'disable-all-subscriptions' },
  { label: '仅告警', value: 'keep-node' }
];

const eventColumns = computed(() => [
  {
    title: '级别',
    key: 'level',
    width: 86,
    render(row: PulseAlertEvent) {
      return h(NTag, { size: 'small', type: levelType(row.level) }, { default: () => levelLabel(row.level) });
    }
  },
  {
    title: '类型',
    key: 'type',
    width: 130,
    render(row: PulseAlertEvent) {
      return eventTypeLabel(row.type);
    }
  },
  { title: '消息', key: 'message', minWidth: 260, ellipsis: { tooltip: true } },
  {
    title: '投递',
    key: 'deliveries',
    minWidth: 180,
    render(row: PulseAlertEvent) {
      return row.deliveries?.length ? row.deliveries.map(item => `${channelLabel(item.channel)}:${deliveryLabel(item.status)}`).join(' / ') : '-';
    }
  },
  {
    title: '动作',
    key: 'eventActions',
    minWidth: 190,
    render(row: PulseAlertEvent) {
      return row.actions?.length ? row.actions.map(item => `${actionLabel(item.type)}:${actionStatusLabel(item.status)}`).join(' / ') : '-';
    }
  },
  {
    title: '状态',
    key: 'status',
    width: 96,
    render(row: PulseAlertEvent) {
      return h(NTag, { size: 'small', type: statusType(row.status) }, { default: () => statusLabel(row.status) });
    }
  },
  {
    title: '时间',
    key: 'createdAt',
    width: 170,
    render(row: PulseAlertEvent) {
      return formatTime(row.createdAt);
    }
  },
  {
    title: '操作',
    key: 'operate',
    width: 150,
    render(row: PulseAlertEvent) {
      return h('div', { class: 'table-actions' }, [
        row.acknowledgedAt ? null : h(NButton, { size: 'tiny', secondary: true, onClick: () => ack(row) }, { default: () => '确认' }),
        h(
          NPopconfirm,
          { onPositiveClick: () => removeEvent(row) },
          {
            default: () => '删除这条告警事件？',
            trigger: () => h(NButton, { size: 'tiny', type: 'error', secondary: true }, { default: () => '删除' })
          }
        )
      ]);
    }
  }
]);

async function loadData() {
  loading.value = true;
  try {
    const [channelRes, policyRes, eventRes] = await Promise.all([fetchPulseChannels(), fetchPulseAlertPolicy(), fetchPulseAlertEvents()]);
    Object.assign(channels, channelRes);
    Object.assign(policy, policyRes);
    events.value = eventRes.items;
  } finally {
    loading.value = false;
  }
}

async function save() {
  saving.value = true;
  try {
    policy.autoDisableOnTrafficLimit = policy.trafficLimitAction !== 'keep-node';
    const [channelRes, policyRes] = await Promise.all([savePulseChannels(channels), savePulseAlertPolicy(policy)]);
    Object.assign(channels, channelRes);
    Object.assign(policy, policyRes);
    window.$message?.success('告警配置已保存');
  } finally {
    saving.value = false;
  }
}

async function runCheck() {
  checking.value = true;
  try {
    const result = await checkPulseAlerts();
    events.value = (await fetchPulseAlertEvents()).items;
    window.$message?.success(`检测完成：离线 ${result.offlineNodes}，新增 ${result.createdEvents}`);
  } finally {
    checking.value = false;
  }
}

async function ack(row: PulseAlertEvent) {
  const next = await ackPulseAlertEvent(row.id);
  events.value = events.value.map(item => (item.id === next.id ? next : item));
}

async function removeEvent(row: PulseAlertEvent) {
  await deletePulseAlertEvent(row.id);
  events.value = events.value.filter(item => item.id !== row.id);
}

function rowKey(row: PulseAlertEvent) {
  return row.id;
}

function levelType(level: string) {
  if (level === 'critical') return 'error';
  if (level === 'warning') return 'warning';
  return 'info';
}

function statusType(status: string) {
  if (status === 'delivered') return 'success';
  if (status === 'pending') return 'warning';
  if (status === 'failed') return 'error';
  if (status === 'acknowledged') return 'info';
  return 'default';
}

function levelLabel(level: string) {
  return { critical: '严重', warning: '警告', info: '信息' }[level] || level;
}

function statusLabel(status: string) {
  return { pending: '待投递', delivered: '已投递', skipped: '已跳过', failed: '失败', acknowledged: '已确认' }[status] || status;
}

function deliveryLabel(status: string) {
  return { pending: '待投递', delivered: '已投递', skipped: '跳过', failed: '失败' }[status] || status;
}

function actionStatusLabel(status: string) {
  return { completed: '完成', skipped: '跳过', failed: '失败' }[status] || status;
}

function channelLabel(channel: string) {
  return { telegram: 'TG', email: '邮件' }[channel] || channel;
}

function actionLabel(type: string) {
  return { 'disable-node-subscription': '禁用节点', 'disable-all-subscriptions': '禁用订阅', 'keep-node': '保留节点' }[type] || type;
}

function eventTypeLabel(type: string) {
  return { 'node-offline': '节点离线', 'node-recovered': '节点恢复', 'traffic-warning': '流量预警', 'traffic-threshold': '流量超限' }[type] || type;
}

function formatTime(value: string) {
  return formatBeijingTime(value);
}

onMounted(loadData);
</script>

<template>
  <NSpace vertical :size="12">
    <NGrid :x-gap="12" :y-gap="12" responsive="screen" item-responsive>
      <NGi span="24 m:12">
        <NCard title="Telegram" :bordered="false" class="card-wrapper compact-card">
          <NForm label-placement="left" label-width="90" size="small">
            <NFormItem label="启用">
              <NSwitch v-model:value="channels.telegram.enabled" />
            </NFormItem>
            <NFormItem label="Bot Token">
              <NInput v-model:value="channels.telegram.botToken" type="password" placeholder="留空表示不修改" />
            </NFormItem>
            <NFormItem label="Chat ID">
              <NInput v-model:value="channels.telegram.chatId" />
            </NFormItem>
          </NForm>
        </NCard>
      </NGi>
      <NGi span="24 m:12">
        <NCard title="邮箱 SMTP" :bordered="false" class="card-wrapper compact-card">
          <NForm label-placement="left" label-width="90" size="small">
            <NFormItem label="启用">
              <NSwitch v-model:value="channels.email.enabled" />
            </NFormItem>
            <NFormItem label="SMTP">
              <NInput v-model:value="channels.email.smtpHost" />
            </NFormItem>
            <NFormItem label="端口">
              <NInputNumber v-model:value="channels.email.smtpPort" class="w-full" />
            </NFormItem>
            <NFormItem label="发件人">
              <NInput v-model:value="channels.email.from" />
            </NFormItem>
            <NFormItem label="收件人">
              <NInput v-model:value="channels.email.to" />
            </NFormItem>
          </NForm>
        </NCard>
      </NGi>
    </NGrid>

    <NCard title="告警策略" :bordered="false" class="card-wrapper compact-card">
      <NGrid :x-gap="12" :y-gap="8" responsive="screen" item-responsive>
        <NGi span="24 s:12 m:6">
          <NFormItem label="离线判定" label-placement="top">
            <NInputNumber v-model:value="policy.offlineAfterSeconds" :min="1" :step="30" class="w-full">
              <template #suffix>秒</template>
            </NInputNumber>
          </NFormItem>
        </NGi>
        <NGi span="24 s:12 m:6">
          <NFormItem label="超限动作" label-placement="top">
            <NSelect v-model:value="policy.trafficLimitAction" :options="trafficActionOptions" />
          </NFormItem>
        </NGi>
        <NGi span="24 m:6">
          <NFormItem label="离线渠道" label-placement="top">
            <NCheckboxGroup v-model:value="policy.offlineChannels">
              <NSpace>
                <NCheckbox v-for="item in channelOptions" :key="item.value" :value="item.value">{{ item.label }}</NCheckbox>
              </NSpace>
            </NCheckboxGroup>
          </NFormItem>
        </NGi>
        <NGi span="24 m:6">
          <NFormItem label="流量渠道" label-placement="top">
            <NCheckboxGroup v-model:value="policy.trafficChannels">
              <NSpace>
                <NCheckbox v-for="item in channelOptions" :key="item.value" :value="item.value">{{ item.label }}</NCheckbox>
              </NSpace>
            </NCheckboxGroup>
          </NFormItem>
        </NGi>
      </NGrid>
      <NSpace>
        <NButton type="primary" size="small" :loading="saving" @click="save">保存</NButton>
        <NButton size="small" :loading="checking" @click="runCheck">检测离线</NButton>
        <NButton size="small" :loading="loading" @click="loadData">刷新</NButton>
      </NSpace>
    </NCard>

    <NCard title="告警事件" :bordered="false" class="card-wrapper compact-card">
      <NDataTable
        size="small"
        :columns="eventColumns"
        :data="events"
        :loading="loading"
        :row-key="rowKey"
        :pagination="{ pageSize: 10 }"
        :scroll-x="1200"
      />
    </NCard>
  </NSpace>
</template>

<style scoped>
.compact-card :deep(.n-card__content) {
  padding-top: 12px;
}

.table-actions {
  display: flex;
  gap: 6px;
  align-items: center;
}
</style>
