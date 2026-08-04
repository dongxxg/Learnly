// Package repository 封装数据访问。每个领域提供 Finder/Saver 等接口，
// 业务层(service)依赖接口而非具体实现，便于单元测试替换为 mock。
package repository
