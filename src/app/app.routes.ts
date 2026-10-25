import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
  {
    path: 'dashboard',
    title: 'Dashboard',
    loadComponent: () => import('./screens/dashboard/dashboard').then((m) => m.Dashboard),
  },
  {
    path: 'groups',
    title: 'Groups',
    loadComponent: () => import('./screens/groups/groups').then((m) => m.Groups),
  },
  {
    path: 'connections',
    title: 'Connections',
    loadComponent: () => import('./screens/connections/connections').then((m) => m.Connections),
  },
  {
    path: 'connections/:id',
    title: 'Connection',
    loadComponent: () => import('./screens/connections/connection-details').then((m) => m.ConnectionDetails),
  },
  {
    path: 'log',
    title: 'Log',
    loadComponent: () => import('./screens/log/log').then((m) => m.Log),
  },
  {
    path: 'profiles/new',
    title: 'New Profile',
    loadComponent: () => import('./screens/profiles/new-profile').then((m) => m.NewProfile),
  },
  {
    path: 'profiles/:id',
    title: 'Edit Profile',
    loadComponent: () => import('./screens/profiles/edit-profile').then((m) => m.EditProfile),
  },
  {
    path: 'profiles/:id/content',
    title: 'Edit Configuration',
    loadComponent: () => import('./screens/profiles/edit-profile-content').then((m) => m.EditProfileContent),
  },
  {
    path: 'tools',
    title: 'Tools',
    loadComponent: () => import('./screens/tools/tools').then((m) => m.Tools),
  },
  {
    path: 'tools/tailscale/:tag',
    title: 'Tailscale',
    loadComponent: () => import('./screens/tools/tailscale/tailscale-endpoint').then((m) => m.TailscaleEndpoint),
  },
  {
    path: 'tools/tailscale/:tag/peer/:peerId',
    title: 'Tailscale peer',
    loadComponent: () => import('./screens/tools/tailscale/tailscale-peer').then((m) => m.TailscalePeerScreen),
  },
  {
    path: 'tools/tailscale/:tag/taildrop',
    title: 'Taildrop',
    loadComponent: () => import('./screens/tools/tailscale/taildrop-inbox').then((m) => m.TaildropInboxScreen),
  },
  {
    path: 'settings',
    title: 'Settings',
    loadComponent: () => import('./screens/settings/settings').then((m) => m.Settings),
  },
  { path: '**', redirectTo: 'dashboard' },
];
