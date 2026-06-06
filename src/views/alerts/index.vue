<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { fetchPulseChannels, savePulseChannels, type PulseChannels } from '@/service/api';

const loading = ref(false);
const channels = reactive<PulseChannels>({
  telegram: { enabled: false, botToken: '', chatId: '', parseMode: 'HTML' },
  email: { enabled: false, smtpHost: '', smtpPort: 587, username: '', password: '', from: '', to: '' }
});

async function loadData() {
  loading.value = true;
  try {
    Object.assign(channels, await fetchPulseChannels());
  } finally {
    loading.value = false;
  }
}

async function save() {
  Object.assign(channels, await savePulseChannels(channels));
  window.$message?.success('告警通道已保存');
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
    <NButton type="primary" :loading="loading" @click="save">保存通道</NButton>
  </NSpace>
</template>
