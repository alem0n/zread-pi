/**
 * BrowsePage - Wiki 文档浏览页面
 *
 * 启动 web 服务器并在浏览器中打开 Wiki 文档界面。
 * ESC 停止服务器并返回上一页。
 */

import { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import { useNavigate } from 'react-router';
import { startWikiBrowseServer, hasWikiCatalog } from '../../commands/browse-server';
import { useI18n } from '../../i18n';
import Divider from '../../components/Divider';
import Spinner from '../../components/Spinner';

export default function BrowsePage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [status, setStatus] = useState<'checking' | 'no-docs' | 'starting' | 'running' | 'stopped'>('checking');
  const [url, setUrl] = useState<string>('');
  const serverRef = useRef<{ close: () => void } | null>(null);

  // 检查是否有文档
  useEffect(() => {
    const projectPath = process.cwd();
    if (!hasWikiCatalog(projectPath)) {
      setStatus('no-docs');
      return;
    }

    // 启动服务器
    setStatus('starting');
    startWikiBrowseServer(projectPath)
      .then((info) => {
        setUrl(info.url);
        serverRef.current = info;
        setStatus('running');
      })
      .catch((err) => {
        console.error('启动服务器失败:', err);
        setStatus('stopped');
      });
  }, []);

  // ESC 处理：停止服务器并返回
  useInput((_input, key) => {
    if (key.escape) {
      if (serverRef.current) {
        serverRef.current.close();
        serverRef.current = null;
      }
      setStatus('stopped');
      // 短暂显示停止状态后返回
      setTimeout(() => {
        navigate('/wiki');
      }, 500);
    }
  });

  // 无文档状态
  if (status === 'no-docs') {
    return (
      <Box flexDirection="column">
        <Divider title={t('browse.noDocs')} color="yellow" />
        <Box marginTop={1}>
          <Text dimColor>{t('common.escBack')}</Text>
        </Box>
      </Box>
    );
  }

  // 正在启动
  if (status === 'checking' || status === 'starting') {
    return (
      <Box flexDirection="column">
        <Divider title={t('browse.starting')} />
        <Box marginTop={1}>
          <Spinner />
          <Text> {t('browse.starting')}</Text>
        </Box>
      </Box>
    );
  }

  // 已停止
  if (status === 'stopped') {
    return (
      <Box flexDirection="column">
        <Divider title={t('browse.stopped')} />
      </Box>
    );
  }

  // 正在运行
  return (
    <Box flexDirection="column">
      <Divider title={t('browse.running')} color="green" />
      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text dimColor>{t('browse.url')}: </Text>
          <Text color="cyan" bold>{url}</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>{t('browse.footer')}</Text>
        </Box>
      </Box>
    </Box>
  );
}