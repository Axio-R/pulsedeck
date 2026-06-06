import { createApp } from 'vue';
import {
  NButton,
  NCard,
  NConfigProvider,
  NDataTable,
  NDescriptions,
  NDescriptionsItem,
  NDivider,
  NEmpty,
  NForm,
  NFormItem,
  NGi,
  NGrid,
  NInput,
  NInputNumber,
  NLayout,
  NLayoutContent,
  NLayoutHeader,
  NLayoutSider,
  NMenu,
  NPopconfirm,
  NSelect,
  NSpace,
  NStatistic,
  NSwitch,
  NTag,
  NThing
} from 'naive-ui';
import App from './App.vue';
import './styles.css';

const app = createApp(App);

[
  NButton,
  NCard,
  NConfigProvider,
  NDataTable,
  NDescriptions,
  NDescriptionsItem,
  NDivider,
  NEmpty,
  NForm,
  NFormItem,
  NGi,
  NGrid,
  NInput,
  NInputNumber,
  NLayout,
  NLayoutContent,
  NLayoutHeader,
  NLayoutSider,
  NMenu,
  NPopconfirm,
  NSelect,
  NSpace,
  NStatistic,
  NSwitch,
  NTag,
  NThing
].forEach((component) => app.component(component.name, component));

app.mount('#app');
