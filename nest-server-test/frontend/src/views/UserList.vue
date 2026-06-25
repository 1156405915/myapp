<template>
  <div class="user-list-container">
    <div class="header">
      <h2 class="title">System Users</h2>
      <el-button type="danger" plain @click="handleLogout">Logout</el-button>
    </div>

    <div class="glass-panel table-box" v-loading="loading">
      <el-table 
        :data="userList" 
        style="width: 100%" 
        class="premium-table"
        :row-class-name="tableRowClassName"
      >
        <el-table-column prop="id" label="ID" width="80" align="center" />
        <el-table-column prop="username" label="Username" />
        <el-table-column prop="phone" label="Phone Number" />
        <el-table-column prop="createdAt" label="Registration Date" :formatter="formatDate" />
      </el-table>

      <div class="empty-state" v-if="!loading && userList.length === 0">
        <el-empty description="No users found" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import request from '../utils/request';

const router = useRouter();
const loading = ref(false);
const userList = ref([]);

const fetchUsers = async () => {
  loading.value = true;
  try {
    const res = await request.get('/auth');
    userList.value = res as any;
  } catch (error) {
    console.error('Failed to fetch users:', error);
  } finally {
    loading.value = false;
  }
};

const handleLogout = () => {
  router.push('/login');
};

const formatDate = (_row: any, _column: any, cellValue: string) => {
  if (!cellValue) return '-';
  const date = new Date(cellValue);
  return date.toLocaleString();
};

const tableRowClassName = ({ rowIndex }: { rowIndex: number }) => {
  if (rowIndex % 2 === 0) {
    return 'even-row';
  }
  return 'odd-row';
};

onMounted(() => {
  fetchUsers();
});
</script>

<style scoped>
.user-list-container {
  width: 100%;
  padding-top: 20px;
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 30px;
}

.title {
  margin: 0;
  font-size: 28px;
  font-weight: 600;
  background: linear-gradient(90deg, #fff, #a2a2bd);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}

.table-box {
  padding: 20px;
  width: 100%;
  box-sizing: border-box;
}

.empty-state {
  padding: 40px 0;
}

/* Premium Table Styling */
:deep(.el-table) {
  background-color: transparent !important;
  color: #fff;
}

:deep(.el-table th.el-table__cell) {
  background-color: rgba(255, 255, 255, 0.05) !important;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1) !important;
  color: #e0e0e0;
  font-weight: 600;
}

:deep(.el-table tr) {
  background-color: transparent !important;
}

:deep(.el-table td.el-table__cell) {
  border-bottom: 1px solid rgba(255, 255, 255, 0.05) !important;
}

:deep(.el-table--enable-row-hover .el-table__body tr:hover > td.el-table__cell) {
  background-color: rgba(255, 255, 255, 0.08) !important;
}

:deep(.even-row) {
  background-color: rgba(255, 255, 255, 0.02) !important;
}

:deep(.el-table::before) {
  display: none;
}
</style>
