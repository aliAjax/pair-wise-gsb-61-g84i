import { ofetch } from 'ofetch';
import type { ApprovalProject, ProjectFilters } from '~/types/certification';
import { mockFetch } from './mock-fetch';
import {
  computeRiskLabel,
  isAcceptanceCurrent,
  recomputeRegulations,
  softwareMatchesBaseline
} from './snapshot';

const client = ofetch.create({
  baseURL: '/api',
  retry: 0
}, {
  fetch: mockFetch as typeof fetch
});

function matches(project: ApprovalProject, filters: ProjectFilters) {
  const query = filters.query.trim().toLowerCase();
  const matchesQuery =
    !query ||
    [project.id, project.name, project.modelCode, project.configuration, project.softwareVersion]
      .join(' ')
      .toLowerCase()
      .includes(query);
  const matchesStatus = filters.status === 'all' || project.status === filters.status;
  const matchesAgency = filters.agency === 'all' || project.agency === filters.agency;

  const stale = project.evidence.some(
    (item) => item.status === 'stale' || (item.status === 'accepted' && !isAcceptanceCurrent(item, project))
  );
  const regulations = recomputeRegulations(project);
  const matchesRisk =
    filters.risk === 'all' ||
    (filters.risk === 'expiring' && new Date(project.certificateExpiry) <= new Date('2026-12-31')) ||
    (filters.risk === 'missing' && regulations.some((item) => item.status === 'missing' || item.status === 'conflict')) ||
    (filters.risk === 'version_conflict' &&
      project.evidence.some((item) => !softwareMatchesBaseline(item, project))) ||
    (filters.risk === 'stale' && stale);

  return matchesQuery && matchesStatus && matchesAgency && matchesRisk;
}

export const certificationApi = {
  async listProjects(filters: ProjectFilters) {
    const projects = await client<ApprovalProject[]>('/projects');
    return projects.filter((project) => matches(project, filters));
  },

  async getProject(id: string) {
    return client<ApprovalProject>(`/projects/${encodeURIComponent(id)}`);
  }
};

export { computeRiskLabel };
