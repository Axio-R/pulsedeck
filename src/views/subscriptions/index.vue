<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import {
  createPulseProfile,
  deletePulseProfile,
  fetchPulseProfiles,
  updatePulseProfile,
  type PulseProfile
} from '@/service/api';

const loading = ref(false);
const profiles = ref<PulseProfile[]>([]);
const form = reactive<{ name: string; format: PulseProfile['format']; description: string }>({
  name: '',
  format: 'raw',
  description: ''
});

async function loadData() {
  loading.value = true;
  try {
    profiles.value = (await fetchPulseProfiles()).items;
  } finally {
    loading.value = false;
  }
}

async function submit() {
  const profile = await createPulseProfile({
    name: form.name || '自定义订阅',
    format: form.format,
    description: form.description
  });
  profiles.value.unshift(profile);
  form.name = '';
  form.format = 'raw';
  form.description = '';
  window.$message?.success('订阅已创建');
}

async function toggle(profile: PulseProfile, enabled: boolean) {
  const next = await updatePulseProfile(profile.id, { enabled });
  profiles.value = profiles.value.map(item => (item.id === profile.id ? next : item));
}

async function remove(profile: PulseProfile) {
  await deletePulseProfile(profile.id);
  profiles.value = profiles.value.filter(item => item.id !== profile.id);
  window.$message?.success('订阅已删除');
}

async function copyUrl(url: string) {
  await navigator.clipboard.writeText(url);
  window.$message?.success('订阅 URL 已复制');
}

onMounted(loadData);
</script>

<template>
  <NSpace vertical :size="16">
    <NCard title="创建订阅 Profile" :bordered="false" class="card-wrapper">
      <NGrid :x-gap="12" :y-gap="12" responsive="screen" item-responsive>
        <NGi span="24 s:7">
          <NInput v-model:value="form.name" placeholder="订阅名称" />
        </NGi>
        <NGi span="24 s:5">
          <NSelect
            v-model:value="form.format"
            :options="[
              { label: 'Raw', value: 'raw' },
              { label: 'Clash', value: 'clash' },
              { label: 'V2Ray Base64', value: 'v2ray' }
            ]"
          />
        </NGi>
        <NGi span="24 s:9">
          <NInput v-model:value="form.description" placeholder="备注" />
        </NGi>
        <NGi span="24 s:3">
          <NButton type="primary" block @click="submit">创建</NButton>
        </NGi>
      </NGrid>
    </NCard>

    <NGrid :x-gap="16" :y-gap="16" responsive="screen" item-responsive>
      <NGi v-for="profile in profiles" :key="profile.id" span="24 m:12 xl:8">
        <NCard :bordered="false" class="card-wrapper">
          <NThing :title="profile.name" :description="profile.description || '订阅 URL'">
            <template #header-extra>
              <NTag size="small">{{ profile.format }}</NTag>
            </template>
          </NThing>
          <NInput class="mt-12px" :value="profile.publicUrl" readonly />
          <NSpace class="mt-12px">
            <NButton size="small" @click="copyUrl(profile.publicUrl)">复制</NButton>
            <NButton size="small" tag="a" :href="profile.publicUrl" target="_blank">打开</NButton>
            <NSwitch :value="profile.enabled" @update:value="value => toggle(profile, value)" />
            <NPopconfirm v-if="profile.deletable" @positive-click="remove(profile)">
              <template #trigger>
                <NButton size="small" type="error" secondary>删除</NButton>
              </template>
              删除这个订阅 URL？
            </NPopconfirm>
            <NTag v-else size="small" type="info">默认保护</NTag>
          </NSpace>
        </NCard>
      </NGi>
    </NGrid>
  </NSpace>
</template>
