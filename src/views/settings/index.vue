<template>
  <NSpace vertical :size="16">
    <NCard title="PulseDeck 设置" :bordered="false" class="card-wrapper">
      <NDescriptions :column="2" bordered>
        <NDescriptionsItem label="项目基础">soybeanjs/soybean-admin</NDescriptionsItem>
        <NDescriptionsItem label="默认端口">14770</NDescriptionsItem>
        <NDescriptionsItem label="GHCR 镜像">ghcr.io/axio-r/pulsedeck:latest</NDescriptionsItem>
        <NDescriptionsItem label="Agent 运行时">Rust native binary</NDescriptionsItem>
        <NDescriptionsItem label="本地命令">PK / pk / RK / rk</NDescriptionsItem>
        <NDescriptionsItem label="部署规则">GitHub Actions 构建镜像后 docker compose pull/up</NDescriptionsItem>
        <NDescriptionsItem label="本地 Docker 构建">禁用</NDescriptionsItem>
      </NDescriptions>
    </NCard>
  </NSpace>
</template>
