#!/usr/bin/env node

var azure = require('./lib/azure_wrapper.js');
var kube = require('./lib/deployment_logic/kubernetes.js');

azure.load_state_for_resizing(process.argv[2], 'kube', parseInt(process.argv[3] || 1));

var coreos_update_channel = process.env['AZ_VM_COREOS_CHANNEL'] || 'stable';

azure.run_task_queue([
  azure.queue_machines('kube', coreos_update_channel, kube.create_node_cloud_config),
]);
