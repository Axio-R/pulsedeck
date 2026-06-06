<script setup lang="ts">
import { computed } from 'vue';
import type { Component } from 'vue';
import { getPaletteColorByNumber, mixColor } from '@sa/color';
import { loginModuleRecord } from '@/constants/app';
import { useAppStore } from '@/store/modules/app';
import { useThemeStore } from '@/store/modules/theme';
import { $t } from '@/locales';
import PwdLogin from './modules/pwd-login.vue';
import CodeLogin from './modules/code-login.vue';
import Register from './modules/register.vue';
import ResetPwd from './modules/reset-pwd.vue';
import BindWechat from './modules/bind-wechat.vue';

interface Props {
  /** The login module */
  module?: UnionKey.LoginModule;
}

const props = defineProps<Props>();

const appStore = useAppStore();
const themeStore = useThemeStore();

interface LoginModule {
  label: App.I18n.I18nKey;
  component: Component;
}

const moduleMap: Record<UnionKey.LoginModule, LoginModule> = {
  'pwd-login': { label: loginModuleRecord['pwd-login'], component: PwdLogin },
  'code-login': { label: loginModuleRecord['code-login'], component: CodeLogin },
  register: { label: loginModuleRecord.register, component: Register },
  'reset-pwd': { label: loginModuleRecord['reset-pwd'], component: ResetPwd },
  'bind-wechat': { label: loginModuleRecord['bind-wechat'], component: BindWechat }
};

const activeModule = computed(() => moduleMap[props.module || 'pwd-login']);

const bgThemeColor = computed(() =>
  themeStore.darkMode ? getPaletteColorByNumber(themeStore.themeColor, 600) : themeStore.themeColor
);

const bgColor = computed(() => {
  const COLOR_WHITE = '#ffffff';

  const ratio = themeStore.darkMode ? 0.5 : 0.2;

  return mixColor(COLOR_WHITE, themeStore.themeColor, ratio);
});
</script>

<template>
  <div class="pulse-login-page" :style="{ backgroundColor: bgColor }">
    <WaveBg :theme-color="bgThemeColor" />
    <section class="pulse-login-panel">
      <header class="flex-y-center justify-between gap-16px">
        <SystemLogo class="size-56px shrink-0 lt-sm:size-48px" />
        <h1 class="min-w-0 flex-1 text-26px text-primary font-600 lt-sm:text-22px">{{ $t('system.title') }}</h1>
        <div class="i-flex-col shrink-0">
          <ThemeSchemaSwitch
            :theme-schema="themeStore.themeScheme"
            :show-tooltip="false"
            class="text-20px lt-sm:text-18px"
            @switch="themeStore.toggleThemeScheme"
          />
          <LangSwitch
            v-if="themeStore.header.multilingual.visible"
            :lang="appStore.locale"
            :lang-options="appStore.localeOptions"
            :show-tooltip="false"
            @change-lang="appStore.changeLocale"
          />
        </div>
      </header>
      <main class="pt-24px">
        <h2 class="text-18px text-primary font-medium">{{ $t(activeModule.label) }}</h2>
        <div class="pt-20px">
          <PwdLogin v-if="!props.module || props.module === 'pwd-login'" />
          <component :is="activeModule.component" v-else />
        </div>
      </main>
    </section>
  </div>
</template>

<style scoped>
.pulse-login-page {
  position: relative;
  min-height: 100vh;
  min-height: 100dvh;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 32px 16px;
}

.pulse-login-panel {
  position: relative;
  z-index: 4;
  width: min(420px, 100%);
  border: 1px solid rgb(226 232 240 / 86%);
  border-radius: 8px;
  background: rgb(255 255 255 / 94%);
  box-shadow: 0 18px 48px rgb(15 23 42 / 14%);
  padding: 28px;
}

@media (max-width: 480px) {
  .pulse-login-page {
    align-items: flex-start;
    padding: 24px 14px;
  }

  .pulse-login-panel {
    padding: 22px;
  }
}
</style>
