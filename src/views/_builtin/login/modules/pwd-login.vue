<script setup lang="ts">
import { reactive, ref } from 'vue';
import { useAuthStore } from '@/store/modules/auth';
import { $t } from '@/locales';

defineOptions({
  name: 'PwdLogin'
});

const authStore = useAuthStore();

interface FormModel {
  userName: string;
  password: string;
}

const model: FormModel = reactive({
  userName: 'admin',
  password: 'change-me'
});

const errorMessage = ref('');

async function handleSubmit() {
  const userName = model.userName.trim();
  const password = model.password;

  if (!userName || !password) {
    errorMessage.value = '请输入账号和密码';
    return;
  }

  errorMessage.value = '';
  await authStore.login(userName, password);
}
</script>

<template>
  <form class="pulse-pwd-login" autocomplete="on" @submit.prevent="handleSubmit">
    <label class="pulse-field">
      <span class="pulse-label">账号</span>
      <input
        v-model="model.userName"
        class="pulse-input"
        name="username"
        autocomplete="username"
        :placeholder="$t('page.login.common.userNamePlaceholder')"
      />
    </label>

    <label class="pulse-field">
      <span class="pulse-label">密码</span>
      <input
        v-model="model.password"
        class="pulse-input"
        name="password"
        type="password"
        autocomplete="current-password"
        :placeholder="$t('page.login.common.passwordPlaceholder')"
      />
    </label>

    <p v-if="errorMessage" class="pulse-error">{{ errorMessage }}</p>

    <button class="pulse-submit" type="submit" :disabled="authStore.loginLoading">
      {{ authStore.loginLoading ? '登录中...' : $t('common.confirm') }}
    </button>

    <p class="pulse-hint">默认账号：admin / change-me</p>
  </form>
</template>

<style scoped>
.pulse-pwd-login {
  display: grid;
  gap: 16px;
}

.pulse-field {
  display: grid;
  gap: 8px;
}

.pulse-label {
  color: rgb(71 85 105);
  font-size: 14px;
  line-height: 20px;
}

.pulse-input {
  width: 100%;
  min-width: 0;
  height: 44px;
  border: 1px solid rgb(203 213 225);
  border-radius: 8px;
  background: rgb(255 255 255);
  color: rgb(15 23 42);
  font-size: 15px;
  line-height: 22px;
  outline: none;
  padding: 0 14px;
  transition:
    border-color 0.18s ease,
    box-shadow 0.18s ease;
}

.pulse-input:focus {
  border-color: rgb(37 99 235);
  box-shadow: 0 0 0 3px rgb(37 99 235 / 12%);
}

.pulse-error {
  margin: 0;
  color: rgb(220 38 38);
  font-size: 13px;
  line-height: 18px;
}

.pulse-submit {
  width: 100%;
  height: 44px;
  border: 0;
  border-radius: 8px;
  background: rgb(37 99 235);
  color: #fff;
  cursor: pointer;
  font-size: 15px;
  font-weight: 600;
  line-height: 22px;
}

.pulse-submit:disabled {
  cursor: not-allowed;
  opacity: 0.72;
}

.pulse-hint {
  margin: 0;
  color: rgb(100 116 139);
  font-size: 13px;
  line-height: 18px;
  text-align: center;
}

</style>
