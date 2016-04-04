#!/usr/bin/env node

var azure = require('./lib/azure_wrapper.js');
var kube = require('./lib/deployment_logic/kubernetes.js');

azure.create_config('kube', { 'etcd': 3, 'kube': 3 });

var coreos_update_channel = process.env['AZ_VM_COREOS_CHANNEL'] || 'stable';

azure.run_task_queue([
  azure.queue_default_network(),
  azure.queue_storage_if_needed(),
  azure.queue_machines('etcd', coreos_update_channel,
    kube.create_etcd_cloud_config),
  azure.queue_machines('kube', coreos_update_channel,
    kube.create_node_cloud_config),
]);
