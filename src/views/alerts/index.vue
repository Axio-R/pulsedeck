<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { fetchPulseAlertPolicy, fetchPulseChannels, savePulseAlertPolicy, savePulseChannels, type PulseAlertPolicy, type PulseChannels } from '@/service/api';

const loading = ref(false);
const channels = reactive<PulseChannels>({
  telegram: { enabled: false, botToken: '', chatId: '', parseMode: 'HTML' },
  email: { enabled: false, smtpHost: '', smtpPort: 587, username: '', password: '', from: '', to: '' }
});
const policy = reactive<PulseAlertPolicy>({
  offlineAfterSeconds: 180,
  offlineChannels: ['telegram', 'email'],
  trafficChannels: ['telegram', 'email'],
  autoDisableOnTrafficLimit: true
});
const channelOptions = [
  { label: 'Telegram', value: 'telegram' },
  { label: '邮箱', value: 'email' }
];

async function loadData() {
  loading.value = true;
  try {
    const [channelRes, policyRes] = await Promise.all([fetchPulseChannels(), fetchPulseAlertPolicy()]);
    Object.assign(channels, channelRes);
    Object.assign(policy, policyRes);
  } finally {
    loading.value = false;
  }
}

async function save() {
  const [channelRes, policyRes] = await Promise.all([savePulseChannels(channels), savePulseAlertPolicy(policy)]);
  Object.assign(channels, channelRes);
  Object.assign(policy, policyRes);
  window.$message?.success('告警配置已保存');
}

onMounted(loadData);
</script>

<template>
  <NSpace vertical :size="16">
    <NGrid :x-gap="16" :y-gap="16" responsive="screen" item-responsive>
      <NGi span="24 m:12">
        <NCard title="Telegram" :bordered="false" class="card-wrapper">
          <NForm label-placement="left" label-width="90">
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
        <NCard title="邮箱 SMTP" :bordered="false" class="card-wrapper">
          <NForm label-placement="left" label-width="90">
            <NFormItem label="启用">
              <NSwitch v-model:value="channels.email.enabled" />
            </NFormItem>
            <NFormItem label="SMTP">
              <NInput v-model:value="channels.email.smtpHost" />
            </NFormItem>
            <NFormItem label="端口">
              <NInputNumber v-model:value="channels.email.smtpPort" />
            </NFormItem>
            <NFormItem label="收件人">
              <NInput v-model:value="channels.email.to" />
            </NFormItem>
          </NForm>
        </NCard>
      </NGi>
    </NGrid>
    <NCard title="告警策略" :bordered="false" class="card-wrapper">
      <NForm label-placement="left" label-width="130">
        <NFormItem label="离线判定">
          <NInputNumber v-model:value="policy.offlineAfterSeconds" :min="30" :step="30">
            <template #suffix>秒</template>
          </NInputNumber>
        </NFormItem>
        <NFormItem label="离线通知渠道">
          <NCheckboxGroup v-model:value="policy.offlineChannels">
            <NSpace>
              <NCheckbox v-for="item in channelOptions" :key="item.value" :value="item.value">{{ item.label }}</NCheckbox>
            </NSpace>
          </NCheckboxGroup>
        </NFormItem>
        <NFormItem label="流量通知渠道">
          <NCheckboxGroup v-model:value="policy.trafficChannels">
            <NSpace>
              <NCheckbox v-for="item in channelOptions" :key="item.value" :value="item.value">{{ item.label }}</NCheckbox>
            </NSpace>
          </NCheckboxGroup>
        </NFormItem>
        <NFormItem label="超限剔除">
          <NSwitch v-model:value="policy.autoDisableOnTrafficLimit" />
        </NFormItem>
      </NForm>
    </NCard>
    <NButton type="primary" :loading="loading" @click="save">保存告警配置</NButton>
  </NSpace>
</template>
