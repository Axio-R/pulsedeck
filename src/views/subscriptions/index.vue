<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import {
  createPulseProfile,
  deletePulseProfile,
  fetchPulseNodes,
  fetchPulseProfiles,
  resetPulseProfileToken,
  restorePulseDefaultProfiles,
  updatePulseProfile,
  type PulseNode,
  type PulseProfile
} from '@/service/api';
import { copyText } from '@/utils/clipboard';
import { compactRegion } from '@/utils/pulse-format';

const loading = ref(false);
const profiles = ref<PulseProfile[]>([]);
const nodes = ref<PulseNode[]>([]);
const form = reactive<{
  name: string;
  format: PulseProfile['format'];
  description: string;
  linkPrefixMode: PulseProfile['linkPrefixMode'];
  nodeIds: string[];
  groups: string[];
  regions: string[];
  tags: string[];
}>({
  name: '',
  format: 'raw',
  description: '',
  linkPrefixMode: 'region',
  nodeIds: [],
  groups: [],
  regions: [],
  tags: []
});
const profileDrafts = reactive<
  Record<string, { linkPrefixMode: PulseProfile['linkPrefixMode']; filters: PulseProfile['filters'] }>
>({});

const nodeOptions = computed(() => nodes.value.map(node => ({ label: node.name, value: node.id })));
const groupOptions = computed(() => uniqueOptions(nodes.value.map(node => node.group || '未分组')));
const regionOptions = computed(() => {
  const regions = nodes.value.map(node => compactRegion(node.displayRegion || node.region)).filter(Boolean);
  return [...new Set(regions)]
    .sort((a, b) => a.localeCompare(b))
    .map(value => ({ label: value, value }));
});
const tagOptions = computed(() => uniqueOptions(nodes.value.flatMap(node => node.tags || [])));

function uniqueOptions(values: string[]) {
  return [...new Set(values.map(value => String(value).trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b))
    .map(value => ({ label: value, value }));
}

async function loadData() {
  loading.value = true;
  try {
    const [profileRes, nodeRes] = await Promise.all([fetchPulseProfiles(), fetchPulseNodes()]);
    profiles.value = profileRes.items;
    nodes.value = nodeRes.items;
  } finally {
    loading.value = false;
  }
}

async function submit() {
  const profile = await createPulseProfile({
    name: form.name || '自定义订阅',
    format: form.format,
    description: form.description,
    linkPrefixMode: form.linkPrefixMode,
    filters: {
      nodeIds: form.nodeIds,
      groups: form.groups,
      regions: form.regions,
      tags: form.tags
    }
  });
  profiles.value.unshift(profile);
  form.name = '';
  form.format = 'raw';
  form.description = '';
  form.linkPrefixMode = 'region';
  form.nodeIds = [];
  form.groups = [];
  form.regions = [];
  form.tags = [];
  window.$message?.success('订阅已创建');
}

async function toggle(profile: PulseProfile, enabled: boolean) {
  const next = await updatePulseProfile(profile.id, { enabled });
  profiles.value = profiles.value.map(item => (item.id === profile.id ? next : item));
}

async function remove(profile: PulseProfile) {
  const result = await deletePulseProfile(profile.id);
  profiles.value = profiles.value.filter(item => item.id !== profile.id);
  window.$message?.success(result.hidden ? '默认订阅已隐藏并停用' : '订阅已删除');
}

async function resetProfileUrl(profile: PulseProfile) {
  const next = await resetPulseProfileToken(profile.id);
  profiles.value = profiles.value.map(item => (item.id === profile.id ? next : item));
  window.$message?.success('订阅链接已重置');
}

async function restoreDefaults() {
  const result = await restorePulseDefaultProfiles();
  profiles.value = result.items;
  window.$message?.success(result.restored ? `已恢复 ${result.restored} 个默认订阅` : '默认订阅已在列表中');
}

function draftFor(profile: PulseProfile) {
  if (!profileDrafts[profile.id]) {
    profileDrafts[profile.id] = {
      linkPrefixMode: profile.linkPrefixMode || 'region',
      filters: {
        nodeIds: [...(profile.filters?.nodeIds || [])],
        groups: [...(profile.filters?.groups || [])],
        regions: [...(profile.filters?.regions || [])],
        tags: [...(profile.filters?.tags || [])]
      }
    };
  }
  return profileDrafts[profile.id];
}

async function saveProfileFilters(profile: PulseProfile) {
  const draft = draftFor(profile);
  const next = await updatePulseProfile(profile.id, {
    linkPrefixMode: draft.linkPrefixMode,
    filters: draft.filters
  });
  profiles.value = profiles.value.map(item => (item.id === profile.id ? next : item));
  delete profileDrafts[profile.id];
  window.$message?.success('订阅过滤已保存');
}

function filterSummary(profile: PulseProfile) {
  const filters = profile.filters;
  const parts = [
    filters?.nodeIds?.length ? `节点 ${filters.nodeIds.length}` : '',
    filters?.groups?.length ? `分组 ${filters.groups.join('/')}` : '',
    filters?.regions?.length ? `区域 ${filters.regions.join('/')}` : '',
    filters?.tags?.length ? `标签 ${filters.tags.join('/')}` : ''
  ].filter(Boolean);
  return parts.join(' · ') || '全部在线节点';
}

async function copyUrl(url: string) {
  if (await copyText(url)) window.$message?.success('订阅 URL 已复制');
  else window.$message?.error('复制失败，请手动选中订阅 URL');
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
        <NGi span="24 s:5">
          <NSelect
            v-model:value="form.linkPrefixMode"
            :options="[
              { label: '地区前缀', value: 'region' },
              { label: '不加前缀', value: 'none' }
            ]"
          />
        </NGi>
        <NGi span="24 s:5">
          <NSelect v-model:value="form.nodeIds" multiple clearable filterable :options="nodeOptions" placeholder="指定节点" />
        </NGi>
        <NGi span="24 s:5">
          <NSelect v-model:value="form.groups" multiple clearable filterable :options="groupOptions" placeholder="筛选分组" />
        </NGi>
        <NGi span="24 s:5">
          <NSelect v-model:value="form.regions" multiple clearable filterable :options="regionOptions" placeholder="筛选区域" />
        </NGi>
        <NGi span="24 s:4">
          <NSelect v-model:value="form.tags" multiple clearable filterable :options="tagOptions" placeholder="筛选标签" />
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
          <div class="profile-meta">
            <NTag size="small" :bordered="false">{{ profile.linkPrefixMode === 'region' ? '地区前缀' : '无前缀' }}</NTag>
            <NText depth="3">{{ filterSummary(profile) }}</NText>
          </div>
          <NInput class="mt-12px" :value="profile.publicUrl" readonly />
          <NSpace class="mt-12px">
            <NButton size="small" @click="copyUrl(profile.publicUrl)">复制</NButton>
            <NButton size="small" tag="a" :href="profile.publicUrl" target="_blank">打开</NButton>
            <NPopconfirm @positive-click="resetProfileUrl(profile)">
              <template #trigger>
                <NButton size="small" secondary>重置链接</NButton>
              </template>
              重置 {{ profile.name }} 的订阅 URL？旧地址会失效。
            </NPopconfirm>
            <NPopover trigger="click" placement="top">
              <template #trigger>
                <NButton size="small" secondary>过滤</NButton>
              </template>
              <NSpace vertical :size="8" class="profile-filter-popover">
                <NSelect
                  v-model:value="draftFor(profile).linkPrefixMode"
                  size="small"
                  :options="[
                    { label: '地区前缀', value: 'region' },
                    { label: '不加前缀', value: 'none' }
                  ]"
                />
                <NSelect v-model:value="draftFor(profile).filters.nodeIds" size="small" multiple clearable filterable :options="nodeOptions" placeholder="指定节点" />
                <NSelect v-model:value="draftFor(profile).filters.groups" size="small" multiple clearable filterable :options="groupOptions" placeholder="筛选分组" />
                <NSelect v-model:value="draftFor(profile).filters.regions" size="small" multiple clearable filterable :options="regionOptions" placeholder="筛选区域" />
                <NSelect v-model:value="draftFor(profile).filters.tags" size="small" multiple clearable filterable :options="tagOptions" placeholder="筛选标签" />
                <NButton size="small" type="primary" @click="saveProfileFilters(profile)">保存过滤</NButton>
              </NSpace>
            </NPopover>
            <NSwitch :value="profile.enabled" @update:value="value => toggle(profile, value)" />
            <NPopconfirm @positive-click="remove(profile)">
              <template #trigger>
                <NButton size="small" type="error" secondary>删除</NButton>
              </template>
              {{ profile.deletable ? '删除这个订阅 URL？' : '隐藏并停用这个默认订阅 URL？' }}
            </NPopconfirm>
          </NSpace>
        </NCard>
      </NGi>
    </NGrid>

    <NButton size="small" secondary @click="restoreDefaults">恢复默认订阅</NButton>
  </NSpace>
</template>

<style scoped>
.profile-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  margin-top: 8px;
}

.profile-meta :deep(.n-text) {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.profile-filter-popover {
  width: min(360px, calc(100vw - 48px));
}
</style>
