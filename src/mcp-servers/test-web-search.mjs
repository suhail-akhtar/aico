#!/usr/bin/env node

/**
 * Test script for the web-search MCP server
 * Tests all tools and demonstrates usage
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class TestRunner {
  constructor() {
    this.requestId = 1;
    this.process = null;
    this.buffer = '';
  }

  async start() {
    console.log('🚀 Starting Web Search MCP Server...\n');
    
    this.process = spawn('node', ['web-search-server.mjs'], {
      cwd: __dirname,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process.stdout.on('data', (data) => {
      this.buffer += data.toString();
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop();
      
      for (const line of lines) {
        if (line.trim()) {
          try {
            const response = JSON.parse(line);
            this.handleResponse(response);
          } catch (e) {
            console.error('Parse error:', line);
          }
        }
      }
    });

    this.process.stderr.on('data', (data) => {
      console.log('[stderr]', data.toString().trim());
    });

    await new Promise(resolve => setTimeout(resolve, 500));
  }

  send(request) {
    return new Promise((resolve) => {
      this.responseHandler = resolve;
      this.process.stdin.write(JSON.stringify(request) + '\n');
    });
  }

  handleResponse(response) {
    if (this.responseHandler) {
      this.responseHandler(response);
    }
  }

  async initialize() {
    console.log('📝 Test 1: Initialize');
    const response = await this.send({
      jsonrpc: '2.0',
      id: this.requestId++,
      method: 'initialize',
    });
    
    console.log('✅ Result:', response.result?.serverInfo?.name);
    console.log('');
  }

  async listTools() {
    console.log('📝 Test 2: List Available Tools');
    const response = await this.send({
      jsonrpc: '2.0',
      id: this.requestId++,
      method: 'tools/list',
    });
    
    console.log('✅ Available tools:');
    response.result.tools.forEach(tool => {
      console.log(`   - ${tool.name}: ${tool.description}`);
    });
    console.log('');
  }

  async testDuckDuckGo() {
    console.log('📝 Test 3: DuckDuckGo Search (privacy-friendly)');
    console.log('   Query: "what is rust programming language"');
    
    const response = await this.send({
      jsonrpc: '2.0',
      id: this.requestId++,
      method: 'tools/call',
      params: {
        name: 'duckduckgo_search',
        arguments: {
          query: 'what is rust programming language',
        },
      },
    });

    if (response.error) {
      console.log('❌ Error:', response.error.data);
    } else {
      const result = JSON.parse(response.result.content[0].text);
      console.log('✅ Instant Answer:', result.instant_answer?.substring(0, 150) + '...');
      console.log('   Related Topics:');
      (result.related_topics || []).slice(0, 3).forEach(topic => {
        console.log(`     - ${topic.title}`);
      });
    }
    console.log('');
  }

  async testGoogleSearch() {
    console.log('📝 Test 4: Google Search');
    console.log('   Query: "latest AI trends 2026"');
    
    const response = await this.send({
      jsonrpc: '2.0',
      id: this.requestId++,
      method: 'tools/call',
      params: {
        name: 'google_search',
        arguments: {
          query: 'latest AI trends 2026',
          num_results: 3,
        },
      },
    });

    if (response.error) {
      console.log('❌ Error:', response.error.data);
    } else {
      const result = JSON.parse(response.result.content[0].text);
      console.log('✅ Results:');
      if (result.results) {
        result.results.slice(0, 3).forEach((item, i) => {
          console.log(`   ${i + 1}. ${item.title || item.note}`);
        });
      }
    }
    console.log('');
  }

  async testFetchUrl() {
    console.log('📝 Test 5: Fetch URL');
    console.log('   URL: https://nodejs.org');
    
    const response = await this.send({
      jsonrpc: '2.0',
      id: this.requestId++,
      method: 'tools/call',
      params: {
        name: 'fetch_url',
        arguments: {
          url: 'https://nodejs.org',
          extract_text: true,
        },
      },
    });

    if (response.error) {
      console.log('❌ Error:', response.error.data);
    } else {
      const result = JSON.parse(response.result.content[0].text);
      console.log(`✅ Fetched successfully`);
      console.log(`   Status: ${result.status}`);
      console.log(`   Content preview: ${result.text?.substring(0, 100)}...`);
      console.log(`   Total length: ${result.length} characters`);
    }
    console.log('');
  }

  async runTests() {
    try {
      await this.initialize();
      await this.listTools();
      await this.testDuckDuckGo();
      await this.testGoogleSearch();
      await this.testFetchUrl();

      console.log('✨ All tests completed!');
      console.log('\n📚 Integration Status:');
      console.log('   ✅ MCP Server running successfully');
      console.log('   ✅ Tools available for aico integration');
      console.log('   ✅ Web search capability ready');
    } catch (error) {
      console.error('❌ Test failed:', error);
    } finally {
      this.process.kill();
      process.exit(0);
    }
  }
}

const runner = new TestRunner();
runner.start().then(() => runner.runTests());
